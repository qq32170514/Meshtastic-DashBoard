// src/database/index.js
const { SQLiteAdapter, ADAPTER_STATES, AUTH_TYPES } = require('./sqlite.adapter');
const { WriteQueue, QUEUE_STATES, ITEM_STATUS } = require('./write-queue');
const { ShutdownHandler } = require('./shutdown-handler');
const { BackupManager, BACKUP_VERIFY_STATUS } = require('./backup-manager');
const defaultConfig = require('./sqlite.config');

function _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager) {
    return {
        // 子系統核心組件
        adapter,
        writeQueue,
        shutdownHandler,
        backupManager,

        // 傳統 sqlite3.Database 相容方法
        run(sql, paramsOrCb, maybeCb) {
            let params = [];
            let callback = null;
            if (typeof paramsOrCb === 'function') {
                callback = paramsOrCb;
            } else {
                params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                if (typeof maybeCb === 'function') callback = maybeCb;
            }

            return adapter.execute(sql, params)
                .then((res) => {
                    if (callback) callback.call(res, null);
                    return res;
                })
                .catch((err) => {
                    if (callback) callback(err);
                    else throw err;
                });
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

            return adapter.queryOne(sql, params)
                .then((row) => {
                    if (callback) callback(null, row);
                    return row;
                })
                .catch((err) => {
                    if (callback) callback(err);
                    else throw err;
                });
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

            return adapter.query(sql, params)
                .then((rows) => {
                    if (callback) callback(null, rows);
                    return rows;
                })
                .catch((err) => {
                    if (callback) callback(err);
                    else throw err;
                });
        },

        serialize(fn) {
            if (typeof fn === 'function') {
                fn();
            }
        },

        close(callback) {
            return shutdownHandler.handle('MANUAL_CLOSE', { exitProcess: false })
                .then(() => {
                    if (callback) callback(null);
                })
                .catch((err) => {
                    if (callback) callback(err);
                    else throw err;
                });
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
}

/**
 * 建立資料庫子系統 (Database Subsystem Factory - P0-1)
 * 進行安全一次性握手，嚴格封裝 Shutdown Authority
 */
async function createDatabaseSubsystem(options = {}) {
    const {
        dbPath,
        backupDir,
        config = {}
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

    await adapter.initialize(dbPath);

    return _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager);
}

/**
 * 同步初始化工廠 (適用於主應用頂層 CommonJS 啟動)
 */
function initDatabaseSubsystemSync(options = {}) {
    const {
        dbPath,
        backupDir,
        config = {}
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

    adapter.initialize(dbPath).catch((err) => {
        console.error('❌ [DATABASE_SUBSYSTEM] 初始化失敗:', err.message);
    });

    return _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager);
}

module.exports = {
    createDatabaseSubsystem,
    initDatabaseSubsystemSync,
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
