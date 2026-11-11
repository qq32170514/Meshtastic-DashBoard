// src/database/index.js
const { SQLiteAdapter, ADAPTER_STATES, AUTH_TYPES } = require('./sqlite.adapter');
const { WriteQueue, QUEUE_STATES, ITEM_STATUS } = require('./write-queue');
const { ShutdownHandler } = require('./shutdown-handler');
const { BackupManager, BACKUP_VERIFY_STATUS } = require('./backup-manager');
const {
    REQUIRED_TABLES,
    COLUMN_MIGRATIONS,
    OBSOLETE_INDEXES,
    REQUIRED_INDEXES,
    getTableColumns,
    verifyDatabaseSchema,
    bootstrapDatabaseSchema
} = require('./schema-bootstrap');
const defaultConfig = require('./sqlite.config');

function _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager) {
    const compat = {
        // 子系統核心組件
        adapter,
        writeQueue,
        shutdownHandler,
        backupManager,

        // 4.0.1 P0: Schema Initialization Barrier 狀態追蹤
        isSchemaReady: false,
        bootstrapError: null,
        schemaReport: null,

        isBootstrapReady() {
            return Boolean(
                adapter.state === ADAPTER_STATES.READY &&
                this.isSchemaReady === true &&
                this.bootstrapError === null
            );
        },

        async bootstrapSchema(schemaOptions = {}) {
            try {
                const report = await bootstrapDatabaseSchema(adapter, schemaOptions);
                this.schemaReport = report;
                this.isSchemaReady = true;
                this.bootstrapError = null;
                return report;
            } catch (err) {
                this.isSchemaReady = false;
                this.bootstrapError = err;
                adapter.setFatalError(err);
                throw err;
            }
        },

        // 傳統 sqlite3.Database 相容方法 (P1-3: Callback Exactly-Once 防重調用)
        run(sql, paramsOrCb, maybeCb) {
            let params = [];
            let callback = null;
            if (typeof paramsOrCb === 'function') {
                callback = paramsOrCb;
            } else {
                params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                if (typeof maybeCb === 'function') callback = maybeCb;
            }

            let callbackCalled = false;
            return adapter.execute(sql, params).then(
                (res) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback.call(res, null);
                    }
                    return res;
                },
                (err) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(err);
                    } else {
                        throw err;
                    }
                }
            );
        },

        get(sql, paramsOrCb, maybeCb) {
            let params = [];
            let callback = null;
            if (typeof paramsOrCb === 'function') {
                callback = paramsOrCb;
            } else {
                params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                if (typeof maybeCb === 'function') callback = maybeCb;
            }

            let callbackCalled = false;
            return adapter.queryOne(sql, params).then(
                (row) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(null, row);
                    }
                    return row;
                },
                (err) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(err);
                    } else {
                        throw err;
                    }
                }
            );
        },

        all(sql, paramsOrCb, maybeCb) {
            let params = [];
            let callback = null;
            if (typeof paramsOrCb === 'function') {
                callback = paramsOrCb;
            } else {
                params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                if (typeof maybeCb === 'function') callback = maybeCb;
            }

            let callbackCalled = false;
            return adapter.query(sql, params).then(
                (rows) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(null, rows);
                    }
                    return rows;
                },
                (err) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(err);
                    } else {
                        throw err;
                    }
                }
            );
        },

        serialize(fn) {
            if (typeof fn === 'function') {
                fn();
            }
        },

        close(callback) {
            backupManager.stopSchedule();
            let callbackCalled = false;
            return shutdownHandler.handle('MANUAL_CLOSE', { exitProcess: false }).then(
                () => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(null);
                    }
                },
                (err) => {
                    if (callback && !callbackCalled) {
                        callbackCalled = true;
                        callback(err);
                    } else {
                        throw err;
                    }
                }
            );
        },

        // WriteQueue 便捷操作
        queueDbOp(sql, params, callback) {
            return writeQueue.enqueue(sql, params, callback);
        },

        flushDbQueue() {
            return writeQueue.flush();
        },

        getMetrics() {
            return {
                queue: writeQueue.getMetrics(),
                adapter: adapter.getActiveStatus()
            };
        }
    };

    return compat;
}

/**
 * 4.0.1 P0: 啟動屏障協調器 (Initialization Barrier Coordinator)
 * 確保唯有在 SQLite Adapter 初始化、PRAGMA 驗證、Schema DDL、Column Migration 與 Schema Verification
 * 全部成功通過屏障後，才允許啟動 HTTP / REST API / Socket.IO / MQTT 與背景工作者。
 */
async function executeWithStartupBarrier(dbSubsystem, services = {}) {
    if (!dbSubsystem) {
        throw new Error('[STARTUP_BARRIER_ERROR] dbSubsystem 為必填');
    }

    if (dbSubsystem.readyPromise) {
        await dbSubsystem.readyPromise;
    }

    if (dbSubsystem.adapter && dbSubsystem.adapter.state !== ADAPTER_STATES.READY) {
        throw new Error(
            `[STARTUP_BARRIER_REJECTED] SQLite Adapter 狀態非 READY (${dbSubsystem.adapter.state})`
        );
    }

    if (dbSubsystem.bootstrapError) {
        throw dbSubsystem.bootstrapError;
    }

    if (dbSubsystem.isSchemaReady !== true) {
        throw new Error('[STARTUP_BARRIER_REJECTED] Schema Initialization Barrier 尚未完成');
    }

    const startedServices = [];

    if (typeof services.startHttp === 'function') {
        await services.startHttp();
        startedServices.push('HTTP_API');
    }
    if (typeof services.startSocketIo === 'function') {
        await services.startSocketIo();
        startedServices.push('SOCKET_IO');
    }
    if (typeof services.startMqtt === 'function') {
        await services.startMqtt();
        startedServices.push('MQTT');
    }
    if (typeof services.startBackgroundWorkers === 'function') {
        await services.startBackgroundWorkers();
        startedServices.push('BACKGROUND_WORKERS');
    }

    return {
        barrierPassed: true,
        startedServices
    };
}

/**
 * 建立資料庫子系統 (Database Subsystem Factory - P0-1 & 4.0.1 P0)
 * 進行安全一次性握手，嚴格封裝 Shutdown Authority 與選配之 Schema Initialization Barrier
 */
async function createDatabaseSubsystem(options = {}) {
    const {
        dbPath,
        backupDir,
        config = {},
        bootstrapSchema = false,
        schemaOptions = {}
    } = options;

    if (!dbPath) {
        throw new Error('[DB_INIT_ERROR] dbPath 為必填參數');
    }

    const mergedConfig = {
        pragmas: { ...defaultConfig.pragmas, ...(config.pragmas || {}) },
        queue: { ...defaultConfig.queue, ...(config.queue || {}) },
        shutdown: { ...defaultConfig.shutdown, ...(config.shutdown || {}) },
        backup: { ...defaultConfig.backup, ...(config.backup || {}) }
    };

    const adapter = new SQLiteAdapter(mergedConfig);
    const shutdownAuthority = adapter.bindShutdownHandler();
    const writeQueue = new WriteQueue(adapter, mergedConfig.queue);
    const shutdownHandler = new ShutdownHandler({
        adapter,
        writeQueue,
        authority: shutdownAuthority,
        config: mergedConfig.shutdown
    });
    const backupManager = new BackupManager(adapter, backupDir, mergedConfig.backup);
    const dbCompat = _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager);

    await adapter.initialize(dbPath);

    if (bootstrapSchema) {
        await dbCompat.bootstrapSchema(schemaOptions);
    }

    dbCompat.readyPromise = Promise.resolve(dbCompat);
    return dbCompat;
}

/**
 * 同步取得相容層包裝，並將 Adapter 初始化、PRAGMA 驗證與 Schema Initialization Barrier
 * 統一納入回傳物件的 readyPromise 屏障中 (4.0.1 P0)
 */
function initDatabaseSubsystemSync(options = {}) {
    const {
        dbPath,
        backupDir,
        config = {},
        bootstrapSchema = false,
        schemaOptions = {}
    } = options;

    if (!dbPath) {
        throw new Error('[DB_INIT_ERROR] dbPath 為必填參數');
    }

    const mergedConfig = {
        pragmas: { ...defaultConfig.pragmas, ...(config.pragmas || {}) },
        queue: { ...defaultConfig.queue, ...(config.queue || {}) },
        shutdown: { ...defaultConfig.shutdown, ...(config.shutdown || {}) },
        backup: { ...defaultConfig.backup, ...(config.backup || {}) }
    };

    const adapter = new SQLiteAdapter(mergedConfig);
    const shutdownAuthority = adapter.bindShutdownHandler();
    const writeQueue = new WriteQueue(adapter, mergedConfig.queue);
    const shutdownHandler = new ShutdownHandler({
        adapter,
        writeQueue,
        authority: shutdownAuthority,
        config: mergedConfig.shutdown
    });
    const backupManager = new BackupManager(adapter, backupDir, mergedConfig.backup);
    const dbCompat = _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager);

    const readyPromise = (async () => {
        try {
            await adapter.initialize(dbPath);
            if (bootstrapSchema) {
                await dbCompat.bootstrapSchema(schemaOptions);
            }
            return dbCompat;
        } catch (err) {
            console.error('❌ [DATABASE_SUBSYSTEM] 初始化或 Schema 屏障失敗:', err.message);
            adapter.setFatalError(err);
            throw err;
        }
    })();

    dbCompat.readyPromise = readyPromise;
    return dbCompat;
}

module.exports = {
    createDatabaseSubsystem,
    initDatabaseSubsystemSync,
    executeWithStartupBarrier,
    bootstrapDatabaseSchema,
    verifyDatabaseSchema,
    getTableColumns,
    REQUIRED_TABLES,
    COLUMN_MIGRATIONS,
    OBSOLETE_INDEXES,
    REQUIRED_INDEXES,
    SQLiteAdapter,
    ADAPTER_STATES,
    AUTH_TYPES,
    WriteQueue,
    QUEUE_STATES,
    ITEM_STATUS,
    ShutdownHandler,
    BackupManager,
    BACKUP_VERIFY_STATUS
};
