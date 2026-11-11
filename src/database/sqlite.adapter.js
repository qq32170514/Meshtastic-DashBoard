// src/database/sqlite.adapter.js
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { pragmas: defaultPragmas } = require('./sqlite.config');

const ADAPTER_STATES = {
    NEW: 'NEW',
    INITIALIZING: 'INITIALIZING',
    READY: 'READY',
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED',
    ERROR: 'ERROR'
};

const AUTH_TYPES = {
    GENERAL: 'GENERAL',
    DRAIN: 'DRAIN',
    MAINTENANCE: 'MAINTENANCE',
    CHECKPOINT: 'CHECKPOINT'
};

const ALLOWED_CHECKPOINT_MODES = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'];

// 🌟 模組私有 WeakMap：憑證完全不可偽造，外部絕對不可見 (P0-5)
const issuedDrainCapabilities = new WeakMap();

function validateDrainCapability(capability, adapter) {
    if (!capability || typeof capability !== 'object') {
        return { valid: false, reason: 'INVALID_OBJECT' };
    }
    const record = issuedDrainCapabilities.get(capability);
    if (!record) {
        return { valid: false, reason: 'UNRECOGNIZED_CAPABILITY' };
    }
    if (record.adapterRef !== adapter || record.adapterInstanceId !== adapter.instanceId) {
        return { valid: false, reason: 'CROSS_ADAPTER_FORBIDDEN' };
    }
    if (record.revoked) {
        return { valid: false, reason: 'CAPABILITY_REVOKED' };
    }
    if (Date.now() > record.expiresAt) {
        return { valid: false, reason: 'CAPABILITY_EXPIRED' };
    }
    return { valid: true, record };
}

class SQLiteAdapter {
    #shutdownBound = false;
    #schedulerPendingCount = 0;
    #schedulerActiveCount = 0;
    #activeTransactions = 0;
    #acceptingNewTasks = true;
    #fatalErrorListeners = [];
    #pragmas;
    #checkpointInProgress = false;
    #databaseFactory = null;

    constructor(config = {}) {
        this.instanceId = crypto.randomUUID();
        this.db = null;
        this.state = ADAPTER_STATES.NEW;
        this.lastError = null;
        this.lastCleanupError = null;
        this._schedulerQueue = Promise.resolve();
        this._closePromise = null;
        this._initPromise = null;
        this.isExecutingUnderlying = false;
        this.maintenanceInProgress = false;
        this.#pragmas = { ...defaultPragmas, ...(config.pragmas || {}) };
        if (typeof config.databaseFactory === 'function') {
            this.#databaseFactory = config.databaseFactory;
        }
    }

    /**
     * 🌟 一次性子系統內部安全綁定 (One-time Subsystem Handshake - P0-5)
     * 僅允許在 createDatabaseSubsystem() 裝配時綁定一次，重複調用立即拋錯
     */
    bindShutdownHandler() {
        if (this.#shutdownBound) {
            throw new Error('[SECURITY_VIOLATION] ShutdownHandler already bound to this adapter');
        }
        this.#shutdownBound = true;

        return {
            issueDrainCapability: (ttlMs = 15000) => {
                const capability = Object.freeze({});
                issuedDrainCapabilities.set(capability, {
                    adapterRef: this,
                    adapterInstanceId: this.instanceId,
                    issuedAt: Date.now(),
                    expiresAt: Date.now() + ttlMs,
                    revoked: false,
                    drainCompleted: false
                });
                return capability;
            },
            markDrainCompleted: (capability) => {
                const auth = validateDrainCapability(capability, this);
                if (!auth.valid) {
                    throw new Error(`[AUTH_DENIED] 無法標記非本實例或已過期之憑證: ${auth.reason}`);
                }
                auth.record.drainCompleted = true;
            },
            isDrainCompleted: (capability) => {
                const auth = validateDrainCapability(capability, this);
                return auth.valid && auth.record.drainCompleted === true;
            }
        };
    }

    /**
     * 註冊致命錯誤監聽器 (P0-5: 確保 Adapter ERROR 立即通知 WriteQueue)
     */
    onFatalError(listener) {
        if (typeof listener === 'function') {
            this.#fatalErrorListeners.push(listener);
        }
    }

    /**
     * 停止接收一般工作閘門 (P0-3, P0-4)
     */
    stopAcceptingNewTasks() {
        this.#acceptingNewTasks = false;
    }

    /**
     * 判定 Adapter 是否已完全達到 Quiescent 靜止狀態 (P0-4, v2.7.5 P0)
     */
    isQuiescent() {
        return (
            !this.isExecutingUnderlying &&
            this.#schedulerPendingCount === 0 &&
            this.#schedulerActiveCount === 0 &&
            this.#activeTransactions === 0 &&
            !this.maintenanceInProgress &&
            !this.#checkpointInProgress
        );
    }

    /**
     * 取得 Adapter 完整執行狀態快照 (P0-3, P0-4, v2.7.5 P0)
     */
    getActiveStatus() {
        return {
            schedulerPending: this.#schedulerPendingCount,
            schedulerActive: this.#schedulerActiveCount,
            underlyingExecuting: this.isExecutingUnderlying,
            activeTransactions: this.#activeTransactions,
            maintenanceInProgress: this.maintenanceInProgress,
            checkpointInProgress: this.#checkpointInProgress,
            acceptingNewTasks: this.#acceptingNewTasks,
            isQuiescent: this.isQuiescent(),
            state: this.state
        };
    }

    _createDatabase(dbPath, callback) {
        if (typeof this.#databaseFactory === 'function') {
            return this.#databaseFactory(dbPath, callback);
        }
        return new sqlite3.Database(dbPath, callback);
    }

    /**
     * 🌟 初始化失敗後等待原生 SQLite 連線 close callback 完成 (v2.7.5 P1)
     * 確保 Cleanup Error 被獨立記錄，絕不覆蓋原始 Initialization Error
     */
    _cleanupFailedInitConnection(dbToClose, initErr) {
        return new Promise((resolve) => {
            if (!dbToClose || typeof dbToClose.close !== 'function') {
                return resolve(null);
            }
            let settled = false;
            try {
                dbToClose.close((closeErr) => {
                    if (settled) return;
                    settled = true;
                    if (closeErr) {
                        this.lastCleanupError = closeErr;
                        if (initErr && typeof initErr === 'object') {
                            initErr.cleanupError = closeErr;
                        }
                        console.error('⚠️ [ADAPTER_INIT_CLEANUP_WARN] 初始化失敗清理連線時報錯:', closeErr.message);
                    }
                    resolve(closeErr || null);
                });
            } catch (syncCloseErr) {
                if (settled) return;
                settled = true;
                this.lastCleanupError = syncCloseErr;
                if (initErr && typeof initErr === 'object') {
                    initErr.cleanupError = syncCloseErr;
                }
                console.error('⚠️ [ADAPTER_INIT_CLEANUP_WARN] 初始化失敗同步呼叫 close 時報錯:', syncCloseErr.message);
                resolve(syncCloseErr);
            }
        });
    }

    initialize(dbPath) {
        if (this._initPromise) return this._initPromise;
        if (this.state !== ADAPTER_STATES.NEW) {
            return Promise.reject(new Error(`無法初始化，當前狀態為: ${this.state}`));
        }
        this.state = ADAPTER_STATES.INITIALIZING;

        this._initPromise = new Promise((resolve, reject) => {
            let dbOpened = false;
            let rawDb = null;

            try {
                rawDb = this._createDatabase(dbPath, async (err) => {
                    if (err) {
                        // Case 1: Database open 失敗，底層連線尚未成功開啟，清空引用但不重複呼叫 close
                        this.db = null;
                        const openErr = new Error(`SQLite 連線失敗: ${err.message}`);
                        this.setFatalError(openErr);
                        this.state = ADAPTER_STATES.ERROR;
                        return reject(openErr);
                    }

                    dbOpened = true;
                    if (!this.db && rawDb) {
                        this.db = rawDb;
                    }

                    try {
                        await this._applyAndVerifyPragmas();
                        this.state = ADAPTER_STATES.READY;
                        resolve();
                    } catch (pErr) {
                        // Case 2: 連線已成功開啟但 PRAGMA 執行或驗證失敗 (v2.7.5 P1)
                        // 1. 保存原始 Initialization Error 並立即將 Adapter 轉為 ERROR
                        this.setFatalError(pErr);
                        this.state = ADAPTER_STATES.ERROR;

                        // 2. 立即清空公開連線 reference，防止外部使用未初始化完成之連線
                        const dbToClose = this.db || rawDb;
                        this.db = null;

                        // 3. 若連線已開啟，必須等待原生 db.close(callback) 完成後才 reject
                        if (dbOpened && dbToClose) {
                            await this._cleanupFailedInitConnection(dbToClose, pErr);
                        }

                        // 4. 確保最終狀態為 ERROR、reference 為 null，且原始錯誤不被 Cleanup Error 覆蓋
                        this.db = null;
                        this.state = ADAPTER_STATES.ERROR;
                        this.lastError = pErr;
                        reject(pErr);
                    }
                });

                if (this.state === ADAPTER_STATES.INITIALIZING && !this.db) {
                    this.db = rawDb;
                }
            } catch (syncErr) {
                this.db = null;
                this.setFatalError(syncErr);
                this.state = ADAPTER_STATES.ERROR;
                reject(syncErr);
            }
        });

        return this._initPromise;
    }

    async _applyAndVerifyPragmas() {
        const pragmas = this.#pragmas;

        // 1. journal_mode (硬性)
        const expectedJournal = String(pragmas.journal_mode || 'WAL').toLowerCase();
        const jRow = await this._rawQueryOne(`PRAGMA journal_mode = ${pragmas.journal_mode}`);
        if (!jRow || String(jRow.journal_mode).toLowerCase() !== expectedJournal) {
            throw new Error(`[HARD_FAIL] PRAGMA journal_mode 驗證失敗: 預期 ${expectedJournal}, 實際 ${JSON.stringify(jRow)}`);
        }

        // 2. synchronous (硬性)
        const syncMap = { OFF: 0, NORMAL: 1, FULL: 2, EXTRA: 3 };
        const expectedSync = typeof pragmas.synchronous === 'number'
            ? pragmas.synchronous
            : (syncMap[String(pragmas.synchronous).toUpperCase()] ?? 1);
        await this._rawExecute(`PRAGMA synchronous = ${pragmas.synchronous}`);
        const sRow = await this._rawQueryOne(`PRAGMA synchronous`);
        if (!sRow || Number(sRow.synchronous) !== expectedSync) {
            throw new Error(`[HARD_FAIL] PRAGMA synchronous 驗證失敗: 預期 ${expectedSync}, 實際 ${JSON.stringify(sRow)}`);
        }

        // 3. busy_timeout (硬性)
        const expectedTimeout = Number(pragmas.busy_timeout);
        await this._rawExecute(`PRAGMA busy_timeout = ${expectedTimeout}`);
        const bRow = await this._rawQueryOne(`PRAGMA busy_timeout`);
        if (!bRow || Number(bRow.timeout) !== expectedTimeout) {
            throw new Error(`[HARD_FAIL] PRAGMA busy_timeout 驗證失敗: 預期 ${expectedTimeout}, 實際 ${JSON.stringify(bRow)}`);
        }

        // 4. foreign_keys (硬性)
        const fkStr = String(pragmas.foreign_keys).toUpperCase();
        const expectedFk = (fkStr === 'ON' || pragmas.foreign_keys === 1 || pragmas.foreign_keys === true) ? 1 : 0;
        await this._rawExecute(`PRAGMA foreign_keys = ${pragmas.foreign_keys}`);
        const fRow = await this._rawQueryOne(`PRAGMA foreign_keys`);
        if (!fRow || Number(fRow.foreign_keys) !== expectedFk) {
            throw new Error(`[HARD_FAIL] PRAGMA foreign_keys 驗證失敗: 預期 ${expectedFk}, 實際 ${JSON.stringify(fRow)}`);
        }

        // 5. wal_autocheckpoint (硬性)
        const expectedWalAuto = Number(pragmas.wal_autocheckpoint);
        await this._rawExecute(`PRAGMA wal_autocheckpoint = ${expectedWalAuto}`);
        const wRow = await this._rawQueryOne(`PRAGMA wal_autocheckpoint`);
        if (!wRow || Number(wRow.wal_autocheckpoint) !== expectedWalAuto) {
            throw new Error(`[HARD_FAIL] PRAGMA wal_autocheckpoint 驗證失敗: 預期 ${expectedWalAuto}, 實際 ${JSON.stringify(wRow)}`);
        }

        // 6. cache_size (軟性)
        await this._rawExecute(`PRAGMA cache_size = ${pragmas.cache_size}`);
        const cRow = await this._rawQueryOne(`PRAGMA cache_size`);
        if (!cRow || Number(cRow.cache_size) !== Number(pragmas.cache_size)) {
            console.warn(`⚠️ [PRAGMA_SOFT_WARN] cache_size 讀回值 (${cRow?.cache_size}) 與設定值 (${pragmas.cache_size}) 不完全相符。`);
        }

        // 7. temp_store (軟性)
        const tempMap = { DEFAULT: 0, FILE: 1, MEMORY: 2 };
        const expectedTemp = typeof pragmas.temp_store === 'number'
            ? pragmas.temp_store
            : (tempMap[String(pragmas.temp_store).toUpperCase()] ?? 2);
        await this._rawExecute(`PRAGMA temp_store = ${pragmas.temp_store}`);
        const tRow = await this._rawQueryOne(`PRAGMA temp_store`);
        if (!tRow || Number(tRow.temp_store) !== expectedTemp) {
            console.warn(`⚠️ [PRAGMA_SOFT_WARN] temp_store 讀回值 (${tRow?.temp_store}) 與預期 (${expectedTemp}) 不符。`);
        }

        // 8. mmap_size (軟性)
        await this._rawExecute(`PRAGMA mmap_size = ${pragmas.mmap_size}`);
        const mRow = await this._rawQueryOne(`PRAGMA mmap_size`);
        if (!mRow || Number(mRow.mmap_size) < 0) {
            console.warn(`⚠️ [PRAGMA_SOFT_WARN] mmap_size 讀回值異常: ${JSON.stringify(mRow)}`);
        }
    }

    _schedule(taskFn, authType = AUTH_TYPES.GENERAL, capability = null) {
        const awaitInit = this._initPromise ? this._initPromise.catch(() => {}) : Promise.resolve();

        return awaitInit.then(() => {
            if (this.state === ADAPTER_STATES.NEW || this.state === ADAPTER_STATES.INITIALIZING) {
                return Promise.reject(new Error(`Adapter 尚未就緒 (狀態: ${this.state})`));
            }
            if (this.state === ADAPTER_STATES.CLOSED) {
                return Promise.reject(new Error('Adapter 已關閉'));
            }
            if (this.state === ADAPTER_STATES.ERROR) {
                return Promise.reject(new Error(`Adapter 處於故障熔斷狀態: ${this.lastError?.message}`));
            }

            // P0-3: 停止接收新一般工作閘門
            if (!this.#acceptingNewTasks && authType !== AUTH_TYPES.DRAIN && authType !== AUTH_TYPES.CHECKPOINT) {
                return Promise.reject(new Error(`[GATE_CLOSED] Adapter 已停止接受 ${authType} 新工作`));
            }

            // 1. 入列時權限檢驗
            if (authType === AUTH_TYPES.DRAIN) {
                const auth = validateDrainCapability(capability, this);
                if (!auth.valid) {
                    return Promise.reject(new Error(`[AUTH_DENIED] DRAIN 拒絕: ${auth.reason}`));
                }
            } else if (authType === AUTH_TYPES.CHECKPOINT) {
                const auth = validateDrainCapability(capability, this);
                if (!auth.valid || !auth.record.drainCompleted) {
                    return Promise.reject(new Error(`[AUTH_DENIED] CHECKPOINT 必須在 Drain 完成後出示有效憑證`));
                }
            } else if (this.state === ADAPTER_STATES.CLOSING) {
                return Promise.reject(new Error(`[ADAPTER_CLOSING] 系統正在關閉，拒絕 ${authType} 任務入列`));
            }

            this.#schedulerPendingCount++;

            const scheduledTask = this._schedulerQueue.then(async () => {
                this.#schedulerPendingCount--;
                this.#schedulerActiveCount++;

                try {
                    // 2. 真正開始執行前的二次檢驗 (Execution Hook)
                    if (this.state === ADAPTER_STATES.ERROR) {
                        throw new Error(`[SCHEDULER_ABORT] Adapter 進入 ERROR 狀態: ${this.lastError?.message}`);
                    }
                    if (this.state === ADAPTER_STATES.CLOSED) {
                        throw new Error('[SCHEDULER_ABORT] Adapter 已關閉');
                    }

                    if (this.state === ADAPTER_STATES.CLOSING) {
                        if (authType === AUTH_TYPES.GENERAL) {
                            throw new Error('[SCHEDULER_SHUTDOWN_ABORT] Adapter 正在關閉，已排隊任務退回');
                        }
                        if (authType === AUTH_TYPES.MAINTENANCE) {
                            throw new Error('[MAINTENANCE_ABORTED_BY_SHUTDOWN] Adapter 正在關閉，已排隊維護任務中止');
                        }
                    }

                    if (authType === AUTH_TYPES.DRAIN || authType === AUTH_TYPES.CHECKPOINT) {
                        const recheck = validateDrainCapability(capability, this);
                        if (!recheck.valid) {
                            throw new Error(`[SCHEDULER_AUTH_EXPIRED] 憑證在執行時已失效: ${recheck.reason}`);
                        }
                    }

                    this.isExecutingUnderlying = true;
                    try {
                        return await taskFn();
                    } finally {
                        this.isExecutingUnderlying = false;
                    }
                } finally {
                    this.#schedulerActiveCount--;
                }
            });

            this._schedulerQueue = scheduledTask.catch(() => {});
            return scheduledTask;
        });
    }

    _rawExecute(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('[DB_NULL] 連線尚未建立或已關閉'));
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    _rawQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('[DB_NULL] 連線尚未建立或已關閉'));
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    _rawQueryOne(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('[DB_NULL] 連線尚未建立或已關閉'));
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    }

    execute(sql, params = []) {
        return this._schedule(() => this._rawExecute(sql, params), AUTH_TYPES.GENERAL);
    }

    query(sql, params = []) {
        return this._schedule(() => this._rawQuery(sql, params), AUTH_TYPES.GENERAL);
    }

    queryOne(sql, params = []) {
        return this._schedule(() => this._rawQueryOne(sql, params), AUTH_TYPES.GENERAL);
    }

    transaction(workFn) {
        return this._executeTransaction(workFn, AUTH_TYPES.GENERAL, null);
    }

    drainTransaction(workFn, capability) {
        return this._executeTransaction(workFn, AUTH_TYPES.DRAIN, capability);
    }

    _executeTransaction(workFn, authType, capability) {
        return this._schedule(async () => {
            this.#activeTransactions++;
            try {
                await this._rawExecute('BEGIN IMMEDIATE TRANSACTION');
                const txContext = {
                    execute: (sql, params) => this._rawExecute(sql, params),
                    query: (sql, params) => this._rawQuery(sql, params),
                    queryOne: (sql, params) => this._rawQueryOne(sql, params)
                };

                try {
                    const result = await workFn(txContext);
                    await this._rawExecute('COMMIT');
                    return result;
                } catch (workErr) {
                    let rollbackErr = null;
                    try {
                        await this._rawExecute('ROLLBACK');
                    } catch (rbErr) {
                        rollbackErr = rbErr;
                    }

                    if (rollbackErr) {
                        const fatalErr = new Error(`[FATAL_ROLLBACK_FAILURE] ROLLBACK 失敗！原始錯誤: [${workErr.message}] | 回滾錯誤: [${rollbackErr.message}]`);
                        this.setFatalError(fatalErr);
                        console.error('🚨 [ADAPTER_CIRCUIT_BREAKER]', fatalErr.message);
                        throw fatalErr;
                    }
                    throw workErr;
                }
            } finally {
                this.#activeTransactions--;
            }
        }, authType, capability);
    }

    maintenanceTask(name, taskFn) {
        return this._schedule(async () => {
            this.maintenanceInProgress = true;
            try {
                const rawContext = {
                    execute: (sql, params) => this._rawExecute(sql, params),
                    query: (sql, params) => this._rawQuery(sql, params),
                    queryOne: (sql, params) => this._rawQueryOne(sql, params)
                };
                return await taskFn(rawContext);
            } finally {
                this.maintenanceInProgress = false;
            }
        }, AUTH_TYPES.MAINTENANCE, null);
    }

    /**
     * 🌟 Checkpoint 具備模式白名單、執行當下 9 項前置條件強驗證與共用 Deadline 超時保護 (P1-2, v2.7.5 P0)
     */
    checkpoint(mode = 'PASSIVE', capability = null, queueMetricsProvider = null, options = {}) {
        const upperMode = String(mode).toUpperCase();
        if (!ALLOWED_CHECKPOINT_MODES.includes(upperMode)) {
            return Promise.reject(new Error(`[INVALID_CHECKPOINT_MODE] 不支援之模式: ${mode}`));
        }

        let timeoutMs = null;
        let deadlineAt = null;
        if (typeof options === 'number') {
            timeoutMs = options;
            deadlineAt = Date.now() + options;
        } else if (options && typeof options === 'object') {
            if (typeof options.deadlineAt === 'number') {
                deadlineAt = options.deadlineAt;
            }
            if (typeof options.timeoutMs === 'number') {
                timeoutMs = options.timeoutMs;
                if (deadlineAt === null) {
                    deadlineAt = Date.now() + options.timeoutMs;
                }
            }
        }

        if (deadlineAt !== null) {
            const remainingBeforeSchedule = deadlineAt - Date.now();
            if (remainingBeforeSchedule <= 0 || (timeoutMs !== null && timeoutMs <= 0)) {
                return Promise.reject(new Error(`[CHECKPOINT_TIMEOUT] wal_checkpoint(${upperMode}) 啟動前已超過 Shutdown Deadline (剩餘: ${remainingBeforeSchedule}ms)`));
            }
        }

        // 預檢驗授權
        const authType = upperMode === 'TRUNCATE' ? AUTH_TYPES.CHECKPOINT : AUTH_TYPES.GENERAL;

        const scheduledCheckpoint = this._schedule(async () => {
            if (deadlineAt !== null && Date.now() >= deadlineAt) {
                throw new Error(`[CHECKPOINT_TIMEOUT] wal_checkpoint(${upperMode}) 排程等待期間已超過 Shutdown Deadline`);
            }

            if (upperMode === 'TRUNCATE') {
                const auth = validateDrainCapability(capability, this);
                if (!auth.valid || !auth.record.drainCompleted) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] TRUNCATE 必須出示已完成 Drain 之有效憑證`);
                }
                if (!queueMetricsProvider || typeof queueMetricsProvider !== 'function') {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] TRUNCATE 要求 queueMetricsProvider 為必填參數函式`);
                }

                const metrics = queueMetricsProvider();
                if (metrics.totalUncommitted > 0 || metrics.inFlightCount > 0) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] 隊列尚有未結資料 (uncommitted: ${metrics.totalUncommitted}, inFlight: ${metrics.inFlightCount})`);
                }
                if (this.maintenanceInProgress) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] 尚有維護任務運行中，禁止 TRUNCATE`);
                }
                if (this.#activeTransactions > 0) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] 尚有在途交易進行中，禁止 TRUNCATE`);
                }
                if (this.#schedulerPendingCount > 0) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] Scheduler 尚有待排程工作，禁止 TRUNCATE`);
                }
            } else if (upperMode === 'FULL' || upperMode === 'RESTART') {
                if (this.#activeTransactions > 0) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] 尚有在途交易進行中，禁止 ${upperMode}`);
                }
                if (this.#schedulerPendingCount > 0) {
                    throw new Error(`[CHECKPOINT_PRECONDITION_FAILED] Scheduler 尚有待排程工作，禁止 ${upperMode}`);
                }
            }

            this.#checkpointInProgress = true;
            try {
                const result = await this._rawQueryOne(`PRAGMA wal_checkpoint(${upperMode})`);
                if (result && Number(result.busy) === 1) {
                    if (upperMode === 'TRUNCATE' || upperMode === 'FULL' || upperMode === 'RESTART') {
                        throw new Error(`[CHECKPOINT_BUSY_BLOCKED] wal_checkpoint(${upperMode}) 遭遇鎖阻塞未完成 (busy: 1, log: ${result.log})`);
                    } else {
                        console.warn(`⚠️ [CHECKPOINT_BUSY] wal_checkpoint(${upperMode}) 部分幀被鎖阻塞:`, result);
                    }
                }
                return result;
            } finally {
                this.#checkpointInProgress = false;
            }
        }, authType, capability);

        if (deadlineAt === null) {
            return scheduledCheckpoint;
        }

        const waitBudget = deadlineAt - Date.now();
        if (waitBudget <= 0) {
            scheduledCheckpoint.catch(() => {});
            return Promise.reject(new Error(`[CHECKPOINT_TIMEOUT] wal_checkpoint(${upperMode}) 剩餘時間預算耗盡 (${waitBudget}ms)`));
        }

        return new Promise((resolve, reject) => {
            const timerId = setTimeout(() => {
                reject(new Error(`[CHECKPOINT_TIMEOUT] wal_checkpoint(${upperMode}) 未在剩餘時限 (${waitBudget}ms) 內完成 (status: ${JSON.stringify(this.getActiveStatus())})`));
            }, waitBudget);

            scheduledCheckpoint.then(
                (res) => {
                    clearTimeout(timerId);
                    resolve(res);
                },
                (err) => {
                    clearTimeout(timerId);
                    reject(err);
                }
            );
        });
    }

    setFatalError(err) {
        this.state = ADAPTER_STATES.ERROR;
        this.lastError = err;
        this.#acceptingNewTasks = false;
        // 🌟 立即可靠通知所有註冊之監聽器 (P0-5)
        for (const listener of this.#fatalErrorListeners) {
            try {
                listener(err);
            } catch (_) {}
        }
    }

    close(timeoutMs = null) {
        if (this._closePromise) return this._closePromise;

        this._closePromise = (async () => {
            if (this.state !== ADAPTER_STATES.ERROR) {
                this.state = ADAPTER_STATES.CLOSING;
            }
            this.#acceptingNewTasks = false;

            const waitBudget = typeof timeoutMs === 'number' ? timeoutMs : null;
            if (waitBudget !== null) {
                if (waitBudget > 0) {
                    let timerId = null;
                    const timeoutPromise = new Promise((_, reject) => {
                        timerId = setTimeout(() => {
                            reject(new Error(`[CLOSE_TIMEOUT] Scheduler 隊列未在時限 (${waitBudget}ms) 內清空`));
                        }, waitBudget);
                    });
                    try {
                        await Promise.race([
                            this._schedulerQueue.catch(() => {}),
                            timeoutPromise
                        ]);
                    } catch (waitErr) {
                        console.warn(`⚠️ [ADAPTER_CLOSE_TIMEOUT] ${waitErr.message}`);
                    } finally {
                        if (timerId) clearTimeout(timerId);
                    }
                } else {
                    console.warn(`⚠️ [ADAPTER_CLOSE_TIMEOUT] [CLOSE_TIMEOUT] 剩餘關閉時間預算不足 (${waitBudget}ms)，不啟動額外等待`);
                }
            } else {
                try {
                    await this._schedulerQueue;
                } catch (_) {}
            }

            if (!this.isQuiescent()) {
                this._closePromise = null;
                throw new Error(`[CLOSE_REJECTED] 尚有在途或排程工作未完成，拒絕強制關閉連線 (status: ${JSON.stringify(this.getActiveStatus())})`);
            }
            return await this._rawClose();
        })();

        return this._closePromise;
    }

    emergencyClose(queueSafetyState = null) {
        if (queueSafetyState && typeof queueSafetyState === 'object') {
            if (queueSafetyState.inFlightCount > 0 || queueSafetyState.flushWorkerActive) {
                throw new Error(`[EMERGENCY_CLOSE_REJECTED] WriteQueue 尚有 In-Flight 項目或 Flush Worker 運行中 (inFlight: ${queueSafetyState.inFlightCount}, flushWorkerActive: ${Boolean(queueSafetyState.flushWorkerActive)})`);
            }
        }
        if (!this.isQuiescent()) {
            throw new Error(`[EMERGENCY_CLOSE_REJECTED] Adapter 尚未達到靜止狀態 (isQuiescent: false, status: ${JSON.stringify(this.getActiveStatus())})`);
        }
        return this._rawClose();
    }

    _rawClose() {
        return new Promise((resolve, reject) => {
            if (this.isExecutingUnderlying || this.#activeTransactions > 0 || this.#checkpointInProgress || this.maintenanceInProgress) {
                return reject(new Error('[RAW_CLOSE_REJECTED] 底層操作運行中禁止調用 _rawClose()'));
            }
            if (!this.db) {
                this.state = ADAPTER_STATES.CLOSED;
                return resolve();
            }
            this.db.close((err) => {
                if (err) {
                    console.error('❌ [ADAPTER] db.close() 釋放連線時報錯:', err.message);
                    this.state = ADAPTER_STATES.ERROR;
                    this.lastError = err;
                    this._closePromise = null;
                    return reject(err);
                }
                this.state = ADAPTER_STATES.CLOSED;
                this.db = null;
                resolve();
            });
        });
    }
}

module.exports = {
    SQLiteAdapter,
    ADAPTER_STATES,
    AUTH_TYPES,
    ALLOWED_CHECKPOINT_MODES
};
