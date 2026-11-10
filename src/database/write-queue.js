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
    REJECTED: 'REJECTED',
    ABANDONED: 'ABANDONED'
};

const ALLOWED_ITEM_TRANSITIONS = {
    [ITEM_STATUS.QUEUED]: [ITEM_STATUS.IN_FLIGHT, ITEM_STATUS.RETRY_PENDING, ITEM_STATUS.REJECTED, ITEM_STATUS.ABANDONED],
    [ITEM_STATUS.IN_FLIGHT]: [ITEM_STATUS.COMMITTED, ITEM_STATUS.RETRY_PENDING, ITEM_STATUS.QUEUED, ITEM_STATUS.ABANDONED],
    [ITEM_STATUS.RETRY_PENDING]: [ITEM_STATUS.QUEUED, ITEM_STATUS.ABANDONED],
    [ITEM_STATUS.COMMITTED]: [],
    [ITEM_STATUS.REJECTED]: [],
    [ITEM_STATUS.ABANDONED]: []
};

class WriteQueue {
    #inFlightCount = 0;
    #config;
    #adapter;

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
        this.queue = [];
        this.retryQueue = [];
        this.flushTimer = null;
        this.isFlushing = false;
        this.lastError = null;

        // Invariants & Accounting
        this.totalAccepted = 0;
        this.totalCommitted = 0;
        this.totalRejected = 0;
        this.totalAbandoned = 0;

        // P0-5: 註冊 Adapter 致命錯誤通知
        if (typeof this.#adapter.onFatalError === 'function') {
            this.#adapter.onFatalError((err) => this.handleAdapterFatalError(err));
        }
    }

    get inFlightCount() {
        return this.#inFlightCount;
    }

    getMetrics() {
        return {
            state: this.state,
            queuedCount: this.queue.length,
            retryPendingCount: this.retryQueue.length,
            inFlightCount: this.#inFlightCount,
            totalUncommitted: this.queue.length + this.retryQueue.length + this.#inFlightCount,
            totalAccepted: this.totalAccepted,
            totalCommitted: this.totalCommitted,
            totalRejected: this.totalRejected,
            totalAbandoned: this.totalAbandoned,
            conservationCheck: (
                this.totalAccepted ===
                (this.totalCommitted + this.queue.length + this.retryQueue.length + this.#inFlightCount + this.totalAbandoned)
            )
        };
    }

    _transitionItem(item, nextStatus) {
        if (item.status === nextStatus) return true;

        const allowed = ALLOWED_ITEM_TRANSITIONS[item.status] || [];
        if (!allowed.includes(nextStatus)) {
            console.error(`🚨 [ITEM_STATE_VIOLATION] 無法從 ${item.status} 轉移至 ${nextStatus} (item ${item.id})`);
            return false;
        }

        const prevStatus = item.status;
        item.status = nextStatus;

        if (prevStatus === ITEM_STATUS.IN_FLIGHT && nextStatus !== ITEM_STATUS.IN_FLIGHT) {
            this.#inFlightCount = Math.max(0, this.#inFlightCount - 1);
        } else if (prevStatus !== ITEM_STATUS.IN_FLIGHT && nextStatus === ITEM_STATUS.IN_FLIGHT) {
            this.#inFlightCount++;
        }

        return true;
    }

    /**
     * P0-5: Adapter 發生致命錯誤時的集中處理
     */
    handleAdapterFatalError(err) {
        this.state = QUEUE_STATES.PAUSED_ERROR;
        this.lastError = err;
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

        // 檢查 Adapter 與 Queue 狀態
        if (
            this.state === QUEUE_STATES.PAUSED_ERROR ||
            this.state === QUEUE_STATES.CLOSED ||
            this.#adapter.state === ADAPTER_STATES.ERROR ||
            this.#adapter.state === ADAPTER_STATES.CLOSED
        ) {
            this.totalRejected++;
            const err = new Error(`[QUEUE_REJECTED] 資料庫或寫入隊列處於錯誤或關閉狀態 (queue: ${this.state}, adapter: ${this.#adapter.state})`);
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
        if (this.queue.length + this.retryQueue.length >= this.#config.maxQueueSize) {
            this.totalRejected++;
            const err = new Error(`[BACKPRESSURE_REJECTED] 隊列已達上限 (${this.#config.maxQueueSize})，寫入拒絕`);
            if (callback) callback(err);
            return false;
        }

        const item = {
            id: crypto.randomUUID(),
            sql,
            params,
            callback,
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
     * 保持批次內相對順序，放回隊列頭部 (P0-4 FIFO Preservation)
     */
    _requeueBatchAtHead(batch) {
        for (const item of batch) {
            this._transitionItem(item, ITEM_STATUS.QUEUED);
        }
        this.queue = [...batch, ...this.queue];
    }

    /**
     * 將項目排入重試等待隊列 (單一歸屬原則：不在 queue 中，只在 retryQueue)
     */
    _scheduleRetry(batch, delayMs) {
        for (const item of batch) {
            item.attempt++;
            this._transitionItem(item, ITEM_STATUS.RETRY_PENDING);
            this.retryQueue.push(item);
        }

        setTimeout(() => {
            if (this.state === QUEUE_STATES.CLOSED || this.state === QUEUE_STATES.PAUSED_ERROR) {
                return;
            }
            // 從 retryQueue 轉移回 queue 頭部
            const toRequeue = [];
            for (const item of batch) {
                const idx = this.retryQueue.indexOf(item);
                if (idx !== -1) {
                    this.retryQueue.splice(idx, 1);
                    toRequeue.push(item);
                }
            }
            if (toRequeue.length > 0) {
                this._requeueBatchAtHead(toRequeue);
                this._checkTriggerFlush();
            }
        }, delayMs);
    }

    /**
     * 觸發隊列 Flush
     */
    async flush(capability = null) {
        if (this.isFlushing) return;
        if (this.queue.length === 0 && this.retryQueue.length === 0) return;
        if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
            return;
        }

        this.isFlushing = true;
        try {
            while (this.queue.length > 0) {
                if (this.state === QUEUE_STATES.PAUSED_DISK_FULL || this.state === QUEUE_STATES.PAUSED_ERROR) {
                    break;
                }

                const batch = this.queue.splice(0, this.#config.batchSize);
                for (const item of batch) {
                    this._transitionItem(item, ITEM_STATUS.IN_FLIGHT);
                }

                try {
                    await this._commitBatchWithBinaryIsolation(batch, capability);
                } catch (batchErr) {
                    // 若有不可恢復錯誤已在內部處理或中斷
                    break;
                }
            }
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * 執行批次寫入，具備完整 Binary Isolation 與 FIFO 維持 (P0-4)
     */
    async _commitBatchWithBinaryIsolation(batch, capability = null) {
        if (!batch || batch.length === 0) return;

        const isDrain = Boolean(capability);
        const executeFn = (txFn) => {
            return isDrain
                ? this.#adapter.drainTransaction(txFn, capability)
                : this.#adapter.transaction(txFn);
        };

        try {
            // 嘗試將整個批次在單一交易內提交
            await executeFn(async (tx) => {
                for (const item of batch) {
                    await tx.execute(item.sql, item.params);
                }
            });

            // 成功提交：Exactly-once Accounting
            for (const item of batch) {
                this._transitionItem(item, ITEM_STATUS.COMMITTED);
                this.totalCommitted++;
                if (item.callback) {
                    try { item.callback(null, { id: item.id, status: 'COMMITTED' }); } catch (_) {}
                }
            }
        } catch (err) {
            const errType = classifyError(err);

            // 1. 磁碟滿額 (SQLITE_FULL): 保持 FIFO 放回隊列頭部，暫停隊列
            if (errType === ERROR_TYPES.DISK_FULL) {
                console.error('🚨 [WRITE_QUEUE_DISK_FULL] 磁碟滿額，停止寫入並保留全部未提交數據');
                this.state = QUEUE_STATES.PAUSED_DISK_FULL;
                this._requeueBatchAtHead(batch);
                throw err;
            }

            // 2. 致命資料毀損 (SQLITE_CORRUPT) 或 回滾失敗: 熔斷
            if (errType === ERROR_TYPES.FATAL_CORRUPT || errType === ERROR_TYPES.ROLLBACK_FAILURE) {
                this.handleAdapterFatalError(err);
                this._requeueBatchAtHead(batch);
                throw err;
            }

            // 3. 鎖競爭 (SQLITE_BUSY / SQLITE_LOCKED) 或 短暫 I/O
            if (errType === ERROR_TYPES.RETRYABLE_BUSY || errType === ERROR_TYPES.IOERR_TRANSIENT) {
                const maxAttempt = Math.max(...batch.map(i => i.attempt));
                if (maxAttempt >= this.#config.maxRetries) {
                    console.error(`❌ [WRITE_QUEUE_MAX_RETRIES] 超過最大重試次數 (${this.#config.maxRetries})，放棄此批次`);
                    for (const item of batch) {
                        this._transitionItem(item, ITEM_STATUS.ABANDONED);
                        this.totalAbandoned++;
                        if (item.callback) {
                            try { item.callback(new Error(`[ABANDONED_MAX_RETRIES] ${err.message}`)); } catch (_) {}
                        }
                    }
                    return;
                }
                const delayMs = calculateBackoffDelay(maxAttempt + 1, this.#config.retryBaseDelayMs, this.#config.retryMaxDelayMs);
                this._scheduleRetry(batch, delayMs);
                return;
            }

            // 4. 資料約束錯誤 (SQLITE_CONSTRAINT / SQLITE_MISMATCH): 執行二分隔離 (Binary Isolation)
            if (errType === ERROR_TYPES.DATA_CONSTRAINT) {
                await this._binaryIsolateBatch(batch, capability);
                return;
            }

            // 5. 其他未預期錯誤：依重試政策處理
            const maxAttempt = Math.max(...batch.map(i => i.attempt));
            if (maxAttempt < this.#config.maxRetries) {
                const delayMs = calculateBackoffDelay(maxAttempt + 1, this.#config.retryBaseDelayMs, this.#config.retryMaxDelayMs);
                this._scheduleRetry(batch, delayMs);
            } else {
                for (const item of batch) {
                    this._transitionItem(item, ITEM_STATUS.ABANDONED);
                    this.totalAbandoned++;
                    if (item.callback) {
                        try { item.callback(err); } catch (_) {}
                    }
                }
            }
        }
    }

    /**
     * 遞迴二分隔離，嚴格保證 FIFO 順序 (Left 優先於 Right) (P0-4)
     */
    async _binaryIsolateBatch(batch, capability = null) {
        if (batch.length === 1) {
            // 單一壞資料：明確隔離並標記 ABANDONED (Quarantine)
            const badItem = batch[0];
            this._transitionItem(badItem, ITEM_STATUS.ABANDONED);
            this.totalAbandoned++;
            if (badItem.callback) {
                try {
                    badItem.callback(new Error(`[QUARANTINED_CONSTRAINT_ERROR] 資料約束違反: ${badItem.sql}`));
                } catch (_) {}
            }
            return;
        }

        const mid = Math.floor(batch.length / 2);
        const left = batch.slice(0, mid);
        const right = batch.slice(mid);

        // 先執行 Left；若 Left 發生非資料約束錯誤 (例如突然 SQLITE_FULL)，必須連同 Right 一起依序放回隊列頭部
        try {
            await this._commitBatchWithBinaryIsolation(left, capability);
        } catch (leftErr) {
            // Left 失敗中斷，將尚未處理的 Right 依序放回
            this._requeueBatchAtHead(right);
            throw leftErr;
        }

        // Left 完成後，再依序執行 Right
        await this._commitBatchWithBinaryIsolation(right, capability);
    }

    /**
     * 恢復磁碟滿額暫停狀態
     */
    resumeDiskFull() {
        if (this.state === QUEUE_STATES.PAUSED_DISK_FULL) {
            this.state = QUEUE_STATES.NORMAL;
            this._checkTriggerFlush();
        }
    }

    /**
     * 安全排空 (Drain - P0-6)
     */
    async drain(capability, deadlineMs = 5000) {
        this.state = QUEUE_STATES.CLOSING;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const startTime = Date.now();

        while (this.queue.length > 0 || this.retryQueue.length > 0 || this.#inFlightCount > 0) {
            if (Date.now() - startTime > deadlineMs) {
                const uncommitted = this.queue.length + this.retryQueue.length + this.#inFlightCount;
                throw new Error(`[DRAIN_DEADLINE_EXPIRED] Drain 超時 (${deadlineMs}ms)，剩餘未提交項目: ${uncommitted}`);
            }

            // 將 retryQueue 中的項目立即推進至 queue
            while (this.retryQueue.length > 0) {
                const item = this.retryQueue.shift();
                this._transitionItem(item, ITEM_STATUS.QUEUED);
                this.queue.push(item);
            }

            if (this.queue.length > 0) {
                const batch = this.queue.splice(0, this.#config.batchSize);
                for (const item of batch) {
                    this._transitionItem(item, ITEM_STATUS.IN_FLIGHT);
                }
                await this._commitBatchWithBinaryIsolation(batch, capability);
            } else if (this.#inFlightCount > 0) {
                await new Promise(r => setTimeout(r, 50));
            }
        }
    }

    close() {
        this.state = QUEUE_STATES.CLOSED;
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
