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
 * @deprecated 由於 SQLite 初始化與 PRAGMA 驗證本質為非同步，同步工廠無法保證回傳時資料庫已就緒。
 * 主應用或模組強烈建議改用 async createDatabaseSubsystem(options)。
 * 若使用本方法，可透過回傳物件的 readyPromise 確保初始化完成；若失敗將自動觸發 setFatalError。
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

    const readyPromise = adapter.initialize(dbPath).catch((err) => {
        console.error('❌ [DATABASE_SUBSYSTEM] 初始化失敗:', err.message);
        adapter.setFatalError(err);
        throw err;
    });

    const dbCompat = _buildDbCompat(adapter, writeQueue, shutdownHandler, backupManager);
    dbCompat.readyPromise = readyPromise;
    return dbCompat;
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
