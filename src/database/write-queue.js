// src/database/write-queue.js
const crypto = require('crypto');
const { queue: defaultQueueConfig } = require('./sqlite.config');
const { classifyError, calculateBackoffDelay, ERROR_TYPES } = require('./retry-policy');
const { ADAPTER_STATES } = require('./sqlite.adapter');

const QUEUE_STATES = {
    NORMAL: 'NORMAL',
    PAUSED_DISK_FULL: 'PAUSED_DISK_FULL',
    PAUSED_ERROR: 'PAUSED_ERROR',
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED'
};

const ITEM_STATUS = {
    QUEUED: 'QUEUED',
    IN_FLIGHT: 'IN_FLIGHT',
    RETRY_PENDING: 'RETRY_PENDING',
    COMMITTED: 'COMMITTED',
    QUARANTINED: 'QUARANTINED',
    UNCOMMITTED_ERROR: 'UNCOMMITTED_ERROR'
};

const ALLOWED_ITEM_TRANSITIONS = {
    [ITEM_STATUS.QUEUED]: [ITEM_STATUS.IN_FLIGHT, ITEM_STATUS.RETRY_PENDING, ITEM_STATUS.UNCOMMITTED_ERROR],
    [ITEM_STATUS.IN_FLIGHT]: [ITEM_STATUS.COMMITTED, ITEM_STATUS.RETRY_PENDING, ITEM_STATUS.QUEUED, ITEM_STATUS.QUARANTINED, ITEM_STATUS.UNCOMMITTED_ERROR],
    [ITEM_STATUS.RETRY_PENDING]: [ITEM_STATUS.QUEUED, ITEM_STATUS.UNCOMMITTED_ERROR],
    [ITEM_STATUS.COMMITTED]: [],
    [ITEM_STATUS.QUARANTINED]: [],
    [ITEM_STATUS.UNCOMMITTED_ERROR]: []
};

class WriteQueue {
    #inFlightItems = new Set();
    #config;
    #adapter;
    #itemSeq = 0;
    #currentFlushPromise = null;

    constructor(adapter, config = {}) {
        if (!adapter) {
            throw new Error('[WRITE_QUEUE_INIT_ERROR] adapter 參數為必填');
        }
        this.#adapter = adapter;

        const maxCapacity = config.maxCapacity || config.maxQueueSize || defaultQueueConfig.maxCapacity || 5000;
        const batchSize = config.batchChunkSize || config.batchSize || defaultQueueConfig.batchChunkSize || 50;
        const maxRetries = config.maxRetryAttempts || config.maxRetries || defaultQueueConfig.maxRetryAttempts || 5;

        this.#config = {
            ...defaultQueueConfig,
            ...config,
            batchSize,
            maxQueueSize: maxCapacity,
            maxRetries,
            flushIntervalMs: config.flushIntervalMs || defaultQueueConfig.flushIntervalMs || 1000,
            retryBaseDelayMs: config.retryBaseDelayMs || defaultQueueConfig.retryBaseDelayMs || 200,
            retryMaxDelayMs: config.retryMaxDelayMs || defaultQueueConfig.retryMaxDelayMs || 5000
        };

        this.state = QUEUE_STATES.NORMAL;
        this.queue = [];                      // QUEUED 容器
        this.retryPendingItems = new Set();   // RETRY_PENDING 容器 (P0-2)
        this.quarantinedItems = [];           // QUARANTINED 容器 (P0-4)
        this.uncommittedErrors = [];          // UNCOMMITTED_ERROR 容器 (P0-4)

        this.flushTimer = null;
        this.isFlushing = false;
        this.lastError = null;
        this._shutdownGateClosed = false;

        // Invariants & Accounting (P0-4)
        this.totalAccepted = 0;
        this.totalCommitted = 0;
        this.totalRejected = 0;
        this.totalQuarantined = 0;
        this.totalUncommittedErrors = 0;

        // P0-5: 註冊 Adapter 致命錯誤通知
        if (typeof this.#adapter.onFatalError === 'function') {
            this.#adapter.onFatalError((err) => this.handleAdapterFatalError(err));
        }
    }

    get inFlightCount() {
        return this.#inFlightItems.size;
    }

    get retryPendingCount() {
        return this.retryPendingItems.size;
    }

    getMetrics() {
        const queuedCount = this.queue.length;
        const inFlightCount = this.#inFlightItems.size;
        const retryPendingCount = this.retryPendingItems.size;
        const uncommittedErrorCount = this.uncommittedErrors.length;
        const totalPending = queuedCount + retryPendingCount + inFlightCount;
        const totalUncommitted = totalPending + uncommittedErrorCount;

        const totalTrackedAccepted = (
            this.totalCommitted +
            totalPending +
            this.totalQuarantined +
            uncommittedErrorCount
        );

        return {
            state: this.state,
            queuedCount,
            retryPendingCount,
            inFlightCount,
            uncommittedErrorCount,
            totalPending,
            totalUncommitted,
            totalAccepted: this.totalAccepted,
            totalCommitted: this.totalCommitted,
            totalRejected: this.totalRejected,
            totalQuarantined: this.totalQuarantined,
            totalUncommittedErrors: uncommittedErrorCount,
            totalAbandoned: this.totalQuarantined + uncommittedErrorCount, // 向後相容指標
            conservationCheck: (this.totalAccepted === totalTrackedAccepted),
            shutdownGateClosed: this._shutdownGateClosed
        };
    }

    /**
     * 🌟 集中式 Callback Exactly-Once 防重調用 (P1-02)
     */
    _invokeCallback(item, err, result = null) {
        if (!item || typeof item.callback !== 'function') return;
        if (item.callbackInvoked) {
            console.warn(`⚠️ [CALLBACK_DUPLICATE_SUPPRESSED] 項目 ${item.id} 已執行過回呼，忽略重複調用`);
            return;
        }
        item.callbackInvoked = true;
        try {
            item.callback(err, result);
        } catch (cbErr) {
            console.error(`❌ [CALLBACK_EXCEPTION] 使用者回呼拋出異常 (item ${item.id}):`, cbErr.message);
        }
    }

    /**
     * 🌟 原子單一狀態轉換與互斥容器管理 (P0-2, P0-4)
     */
    _transitionItem(item, nextStatus, error = null) {
        if (item.status === nextStatus) return true;

        const allowed = ALLOWED_ITEM_TRANSITIONS[item.status] || [];
        if (!allowed.includes(nextStatus)) {
            console.error(`🚨 [ITEM_STATE_VIOLATION] 無法從 ${item.status} 轉移至 ${nextStatus} (item ${item.id})`);
            return false;
        }

        const prevStatus = item.status;

        // 1. 從原容器移除 (保證互斥)
        if (prevStatus === ITEM_STATUS.QUEUED) {
            const idx = this.queue.indexOf(item);
            if (idx !== -1) this.queue.splice(idx, 1);
        } else if (prevStatus === ITEM_STATUS.IN_FLIGHT) {
            this.#inFlightItems.delete(item);
        } else if (prevStatus === ITEM_STATUS.RETRY_PENDING) {
            this.retryPendingItems.delete(item);
        }

        // 2. 更新狀態與錯誤
        item.status = nextStatus;
        if (error) item.lastError = error;

        // 3. 加入新容器與累加計數
        if (nextStatus === ITEM_STATUS.QUEUED) {
            // 注意：入列位置由調用端決定（如 push 或 prepend）
        } else if (nextStatus === ITEM_STATUS.IN_FLIGHT) {
            this.#inFlightItems.add(item);
        } else if (nextStatus === ITEM_STATUS.RETRY_PENDING) {
            this.retryPendingItems.add(item);
        } else if (nextStatus === ITEM_STATUS.COMMITTED) {
            this.totalCommitted++;
        } else if (nextStatus === ITEM_STATUS.QUARANTINED) {
            this.totalQuarantined++;
            this.quarantinedItems.push({
                id: item.id,
                sql: item.sql,
                params: item.params,
                attempt: item.attempt,
                error: error ? error.message : 'QUARANTINED',
                timestamp: Date.now()
            });
        } else if (nextStatus === ITEM_STATUS.UNCOMMITTED_ERROR) {
            this.totalUncommittedErrors++;
            this.uncommittedErrors.push({
                id: item.id,
                sql: item.sql,
                params: item.params,
                seq: item.seq,
                attempt: item.attempt,
                error: error ? error.message : 'UNCOMMITTED_ERROR',
                timestamp: Date.now()
            });
        }

        return true;
    }

    /**
     * P0-5: Adapter 發生致命錯誤時的集中處理
     */
    handleAdapterFatalError(err) {
        this.state = QUEUE_STATES.PAUSED_ERROR;
        this.lastError = err;
        this._shutdownGateClosed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * 寫入請求入列
     */
    enqueue(sqlOrItem, paramsOrCb, maybeCb) {
        let sql;
        let params = [];
        let callback = null;

        if (typeof sqlOrItem === 'object' && sqlOrItem !== null && typeof sqlOrItem.sql === 'string') {
            sql = sqlOrItem.sql;
            params = sqlOrItem.params || [];
            callback = sqlOrItem.callback || (typeof paramsOrCb === 'function' ? paramsOrCb : null);
        } else {
            sql = sqlOrItem;
            if (typeof paramsOrCb === 'function') {
                callback = paramsOrCb;
            } else {
                params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                if (typeof maybeCb === 'function') callback = maybeCb;
            }
        }

        // 檢查 Adapter 與 Queue 狀態 (P1-1: 包含 PAUSED_DISK_FULL)
        const adapterStatus = typeof this.#adapter.getActiveStatus === 'function' ? this.#adapter.getActiveStatus() : null;
        if (
            this._shutdownGateClosed ||
            (adapterStatus && !adapterStatus.acceptingNewTasks) ||
            this.state === QUEUE_STATES.PAUSED_DISK_FULL ||
            this.state === QUEUE_STATES.PAUSED_ERROR ||
            this.state === QUEUE_STATES.CLOSED ||
            this.#adapter.state === ADAPTER_STATES.ERROR ||
            this.#adapter.state === ADAPTER_STATES.CLOSED
        ) {
            this.totalRejected++;
            const reason = this.state === QUEUE_STATES.PAUSED_DISK_FULL ? '磁碟滿額暫停' : '錯誤或關閉狀態';
            const err = new Error(`[QUEUE_REJECTED] 資料庫或寫入隊列處於${reason} (queue: ${this.state}, adapter: ${this.#adapter.state})`);
            if (callback) callback(err);
            return false;
        }

        if (this.state === QUEUE_STATES.CLOSING) {
            this.totalRejected++;
            const err = new Error('[QUEUE_REJECTED] 系統關閉中，拒絕新寫入');
            if (callback) callback(err);
            return false;
        }

        // 背壓檢查 (Backpressure)
        if (this.queue.length + this.retryPendingItems.size >= this.#config.maxQueueSize) {
            this.totalRejected++;
            const err = new Error(`[BACKPRESSURE_REJECTED] 隊列已達上限 (${this.#config.maxQueueSize})，寫入拒絕`);
            if (callback) callback(err);
            return false;
        }

        const item = {
            id: crypto.randomUUID(),
            seq: ++this.#itemSeq,
            sql,
            params,
            callback,
            callbackInvoked: false,
            status: ITEM_STATUS.QUEUED,
            attempt: 0,
            enqueuedAt: Date.now()
        };

        this.totalAccepted++;
        this.queue.push(item);

        this._checkTriggerFlush();
        return true;
    }

    _checkTriggerFlush() {
        if (this._shutdownGateClosed) return;
        if (this.state !== QUEUE_STATES.NORMAL && this.state !== QUEUE_STATES.CLOSING) {
            return;
        }

        if (this.queue.length >= this.#config.batchSize) {
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }
            this.flush();
        } else if (!this.flushTimer && this.queue.length > 0) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush();
            }, this.#config.flushIntervalMs);
        }
    }

    /**
     * 🌟 保持批次內相對順序，一次性原子退回隊列頭部 (P0-1 FIFO Preservation)
     */
    _requeueRemainingBatchAtHead(batch) {
        if (!batch || batch.length === 0) return;
        // 嚴格依原始 seq 順序排序
        const sorted = [...batch].sort((a, b) => a.seq - b.seq);
        for (const item of sorted) {
            this._transitionItem(item, ITEM_STATUS.QUEUED);
        }
        this.queue = [...sorted, ...this.queue];
    }

    /**
     * 將項目排入重試等待隊列 (單一歸屬原則：不在 queue 中，只在 retryPendingItems)
     */
    _scheduleRetry(batch, delayMs, deadlineAt = null) {
        // P0-3: 檢查剩餘預算
        if (deadlineAt) {
            const remainingBudget = deadlineAt - Date.now();
            if (delayMs > remainingBudget) {
                console.warn(`⚠️ [RETRY_BUDGET_EXCEEDED] 退避延遲 (${delayMs}ms) 超過剩餘預算 (${remainingBudget}ms)，轉為 UNCOMMITTED_ERROR`);
                for (const item of batch) {
                    this._transitionItem(item, ITEM_STATUS.UNCOMMITTED_ERROR, new Error('[RETRY_BUDGET_EXCEEDED]'));
                    this._invokeCallback(item, new Error('[RETRY_BUDGET_EXCEEDED] 停機期限內無法完成重試'));
                }
                return;
            }
        }

        for (const item of batch) {
            item.attempt++;
            this._transitionItem(item, ITEM_STATUS.RETRY_PENDING);
        }

        setTimeout(() => {
            if (this.state === QUEUE_STATES.CLOSED || this.state === QUEUE_STATES.PAUSED_ERROR) {
                return;
            }
            // 從 retryPendingItems 轉移回 queue
            const toRequeue = [];
            for (const item of batch) {
                if (this.retryPendingItems.has(item)) {
                    toRequeue.push(item);
                }
            }
            if (toRequeue.length > 0) {
                this._requeueRemainingBatchAtHead(toRequeue);
                this._checkTriggerFlush();
            }
        }, delayMs);
    }

    /**
     * 觸發隊列 Flush
     */
    async flush(capability = null, deadlineAt = null) {
        while (this.#currentFlushPromise) {
            await this.#currentFlushPromise;
        }

        if (this.queue.length === 0 && this.retryPendingItems.size === 0) return;
        if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
            return;
        }

        this.isFlushing = true;
        const flushPromise = (async () => {
            try {
                while (this.queue.length > 0) {
                    if (this._shutdownGateClosed && !capability) break;
                    if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
                        break;
                    }

                    const batch = this.queue.splice(0, this.#config.batchSize);
                    for (const item of batch) {
                        this._transitionItem(item, ITEM_STATUS.IN_FLIGHT);
                    }

                    try {
                        await this._executeTopLevelBatch(batch, capability, deadlineAt);
                    } catch (batchErr) {
                        break;
                    }
                }
            } finally {
                this.isFlushing = false;
                this.#currentFlushPromise = null;
            }
        })();

        this.#currentFlushPromise = flushPromise;
        await flushPromise;
    }

    /**
     * 🌟 最外層統一管理批次執行與集中式剩餘資料回退 (P0-1)
     */
    async _executeTopLevelBatch(batch, capability = null, deadlineAt = null) {
        try {
            await this._commitOrIsolate(batch, capability, deadlineAt);
        } catch (err) {
            // 找出此批次中「尚未提交且尚未隔離」的所有剩餘資料
            const remaining = batch.filter(item => (
                item.status !== ITEM_STATUS.COMMITTED &&
                item.status !== ITEM_STATUS.QUARANTINED &&
                item.status !== ITEM_STATUS.UNCOMMITTED_ERROR
            ));

            const errType = classifyError(err);

            if (errType === ERROR_TYPES.DISK_FULL) {
                this.state = QUEUE_STATES.PAUSED_DISK_FULL;
                if (this.flushTimer) {
                    clearTimeout(this.flushTimer);
                    this.flushTimer = null;
                }
                this._requeueRemainingBatchAtHead(remaining);
                throw err;
            } else if (err.message && err.message.includes('DEADLINE_EXPIRED')) {
                // P0-2: Deadline 到期，剩餘尚未提交的子批次按原始 seq 完整原子退回隊列頭部
                this._requeueRemainingBatchAtHead(remaining);
                throw err;
            } else if (errType === ERROR_TYPES.FATAL_CORRUPT || errType === ERROR_TYPES.ROLLBACK_FAILURE || errType === ERROR_TYPES.UNKNOWN) {
                // P1-01: UNKNOWN 與致命損毀立即熔斷並保留所有未提資料
                this.handleAdapterFatalError(err);
                for (const item of remaining) {
                    this._transitionItem(item, ITEM_STATUS.UNCOMMITTED_ERROR, err);
                    this._invokeCallback(item, err);
                }
                throw err;
            } else if (errType === ERROR_TYPES.RETRYABLE_BUSY || errType === ERROR_TYPES.IOERR_TRANSIENT) {
                const maxAttempt = Math.max(...remaining.map(i => i.attempt));
                if (maxAttempt >= this.#config.maxRetries) {
                    for (const item of remaining) {
                        this._transitionItem(item, ITEM_STATUS.UNCOMMITTED_ERROR, err);
                        this._invokeCallback(item, new Error(`[ABANDONED_MAX_RETRIES] ${err.message}`));
                    }
                    return;
                }
                const delayMs = calculateBackoffDelay(maxAttempt + 1, this.#config.retryBaseDelayMs, this.#config.retryMaxDelayMs);
                this._scheduleRetry(remaining, delayMs, deadlineAt);
            } else {
                for (const item of remaining) {
                    this._transitionItem(item, ITEM_STATUS.UNCOMMITTED_ERROR, err);
                    this._invokeCallback(item, err);
                }
            }
        }
    }

    async _commitOrIsolate(batch, capability = null, deadlineAt = null) {
        if (!batch || batch.length === 0) return;

        // P0-2: 統一交易准入檢查 (Admission Check)
        if (deadlineAt && Date.now() >= deadlineAt) {
            throw new Error(`[DEADLINE_EXPIRED] 停機期限 (${deadlineAt}) 已到達，禁止啟動新交易`);
        }
        if (this._shutdownGateClosed && !capability) {
            throw new Error('[GATE_CLOSED] 停機閘門已關閉，禁止啟動非 Drain 交易');
        }
        if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
            throw new Error(`[QUEUE_PAUSED] 寫入隊列處於暫停狀態 (${this.state})，禁止啟動新交易`);
        }

        const isDrain = Boolean(capability);
        const executeFn = (txFn) => {
            return isDrain
                ? this.#adapter.drainTransaction(txFn, capability)
                : this.#adapter.transaction(txFn);
        };

        try {
            await executeFn(async (tx) => {
                for (const item of batch) {
                    await tx.execute(item.sql, item.params);
                }
            });

            // 成功提交：Exactly-once Accounting (P1-02)
            for (const item of batch) {
                this._transitionItem(item, ITEM_STATUS.COMMITTED);
                this._invokeCallback(item, null, { id: item.id, status: 'COMMITTED' });
            }
        } catch (err) {
            const errType = classifyError(err);

            // 僅在資料約束錯誤時遞迴二分拆分 (P0-1)
            if (errType === ERROR_TYPES.DATA_CONSTRAINT) {
                await this._binaryIsolateBatch(batch, capability, deadlineAt);
                return;
            }

            // 非資料約束錯誤（DISK_FULL, UNKNOWN, BUSY, DEADLINE 等）直接向上拋出，由最外層統一退回！
            throw err;
        }
    }

    /**
     * 遞迴二分拆分：子層不自行退回，保持 Left 優先 (P0-1, P0-2)
     */
    async _binaryIsolateBatch(batch, capability = null, deadlineAt = null) {
        if (batch.length === 1) {
            // 單一壞資料：明確隔離並標記 QUARANTINED (P0-4)
            const badItem = batch[0];
            const constraintErr = new Error(`[QUARANTINED_CONSTRAINT_ERROR] 資料約束違反: ${badItem.sql}`);
            this._transitionItem(badItem, ITEM_STATUS.QUARANTINED, constraintErr);
            this._invokeCallback(badItem, constraintErr);
            return;
        }

        // P0-2: 遞迴前再次檢查 Deadline，防止子批次超時啟動新交易
        if (deadlineAt && Date.now() >= deadlineAt) {
            throw new Error(`[DEADLINE_EXPIRED] 停機期限已到達，禁止遞迴拆分執行子批次`);
        }

        const mid = Math.floor(batch.length / 2);
        const left = batch.slice(0, mid);
        const right = batch.slice(mid);

        // 先執行 Left，若 Left 拋出非約束錯誤，直接往上拋給 _executeTopLevelBatch 統一原子排回
        await this._commitOrIsolate(left, capability, deadlineAt);

        // P0-2: Left 成功後再檢查 Deadline，若超時則拋出 DEADLINE_EXPIRED，由頂層統一退回 Right
        if (deadlineAt && Date.now() >= deadlineAt) {
            throw new Error(`[DEADLINE_EXPIRED] 停機期限已到達，禁止執行右側子批次`);
        }

        // Left 成功且在期限內，再執行 Right
        await this._commitOrIsolate(right, capability, deadlineAt);
    }

    resumeDiskFull() {
        if (this.state === QUEUE_STATES.PAUSED_DISK_FULL) {
            this.state = QUEUE_STATES.NORMAL;
            this._checkTriggerFlush();
        }
    }

    /**
     * 🌟 安全排空 (Drain - P0-3: 具備獨立 Deadline Observer 與 Promise.race)
     */
    async drain(capability, deadlineMs = 5000) {
        this.state = QUEUE_STATES.CLOSING;
        this._shutdownGateClosed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const deadlineAt = Date.now() + deadlineMs;

        // 獨立 Deadline Observer Promise
        let deadlineTimeoutId = null;
        const deadlinePromise = new Promise((resolve) => {
            deadlineTimeoutId = setTimeout(() => {
                const totalUncommitted = this.queue.length + this.retryPendingItems.size + this.#inFlightItems.size + this.uncommittedErrors.length;
                resolve({
                    isClean: false,
                    isQuiescent: typeof this.#adapter.isQuiescent === 'function' ? this.#adapter.isQuiescent() : true,
                    hasUncommittedErrors: this.uncommittedErrors.length > 0,
                    isDiskFull: this.state === QUEUE_STATES.PAUSED_DISK_FULL,
                    deadlineExpired: true,
                    uncommitted: totalUncommitted,
                    adapterStatus: this.#adapter.getActiveStatus()
                });
            }, deadlineMs);
        });

        // 實際排空工作 Worker Promise
        const drainWorkerPromise = (async () => {
            while (this.queue.length > 0 || this.retryPendingItems.size > 0 || this.#inFlightItems.size > 0) {
                if (Date.now() >= deadlineAt) {
                    break;
                }
                // P0-3: 磁碟滿額或嚴重錯誤時立即中止 Drain，避免無限重試
                if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
                    break;
                }

                // 將 retryPendingItems 推進回隊列
                if (this.retryPendingItems.size > 0) {
                    const toRequeue = Array.from(this.retryPendingItems);
                    this._requeueRemainingBatchAtHead(toRequeue);
                }

                if (this.queue.length > 0) {
                    const batch = this.queue.splice(0, this.#config.batchSize);
                    for (const item of batch) {
                        this._transitionItem(item, ITEM_STATUS.IN_FLIGHT);
                    }
                    try {
                        await this._executeTopLevelBatch(batch, capability, deadlineAt);
                    } catch (batchErr) {
                        // 若遇到磁碟滿額或嚴重錯誤，立即中斷排空迴圈 (P0-3)
                        if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
                            break;
                        }
                    }
                } else if (this.#inFlightItems.size > 0) {
                    await new Promise(r => setTimeout(r, 20));
                }
            }

            const totalUncommitted = this.queue.length + this.retryPendingItems.size + this.#inFlightItems.size + this.uncommittedErrors.length;
            const hasErrors = this.uncommittedErrors.length > 0;
            const isDiskFull = this.state === QUEUE_STATES.PAUSED_DISK_FULL;
            const clean = (totalUncommitted === 0 && !isDiskFull);

            return {
                isClean: clean,
                isQuiescent: typeof this.#adapter.isQuiescent === 'function' ? this.#adapter.isQuiescent() : true,
                hasUncommittedErrors: hasErrors,
                isDiskFull,
                deadlineExpired: (Date.now() >= deadlineAt),
                uncommitted: totalUncommitted,
                adapterStatus: this.#adapter.getActiveStatus()
            };
        })();

        try {
            const result = await Promise.race([drainWorkerPromise, deadlinePromise]);
            if (deadlineTimeoutId) clearTimeout(deadlineTimeoutId);
            return result;
        } catch (err) {
            if (deadlineTimeoutId) clearTimeout(deadlineTimeoutId);
            throw err;
        }
    }

    close() {
        this.state = QUEUE_STATES.CLOSED;
        this._shutdownGateClosed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }
}

module.exports = {
    WriteQueue,
    QUEUE_STATES,
    ITEM_STATUS
};
