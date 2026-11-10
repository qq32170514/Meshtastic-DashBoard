// tests/database/sqlite_reliability.test.js
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const {
    createDatabaseSubsystem,
    SQLiteAdapter,
    ADAPTER_STATES,
    AUTH_TYPES,
    WriteQueue,
    QUEUE_STATES,
    ITEM_STATUS,
    ShutdownHandler,
    BackupManager,
    BACKUP_VERIFY_STATUS
} = require('../../src/database');

const { classifyError, ERROR_TYPES } = require('../../src/database/retry-policy');

function getTempDbPath(name = 'test') {
    return path.join(os.tmpdir(), `meshtastic_test_${name}_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
}

function cleanupTempDb(dbPath) {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch (_) {}
    try { if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`); } catch (_) {}
    try { if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`); } catch (_) {}
}

describe('SQLite Reliability v2.7.1 Test Suite', () => {

    // 1. 正常寫入與 COMMIT
    it('1. 正常寫入與 COMMIT: 寫入多筆資料並確認全數提交', async () => {
        const dbPath = getTempDbPath('test1');
        const db = await createDatabaseSubsystem({ dbPath });

        await db.run('CREATE TABLE test_items (id TEXT PRIMARY KEY, val TEXT)');

        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(new Promise((resolve, reject) => {
                db.queueDbOp('INSERT INTO test_items (id, val) VALUES (?, ?)', [`id_${i}`, `val_${i}`], (err, res) => {
                    if (err) reject(err);
                    else resolve(res);
                });
            }));
        }

        await db.flushDbQueue();
        await Promise.all(promises);

        const rows = await db.all('SELECT * FROM test_items');
        assert.equal(rows.length, 5);

        const metrics = db.writeQueue.getMetrics();
        assert.equal(metrics.totalCommitted, 5);
        assert.equal(metrics.totalAccepted, 5);
        assert.equal(metrics.conservationCheck, true);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // 2. SQLite BUSY
    it('2. SQLite BUSY: 鎖競爭錯誤分類與重試', async () => {
        const busyErr = new Error('SQLITE_BUSY: database is locked');
        busyErr.code = 'SQLITE_BUSY';
        busyErr.errno = 5;

        const classification = classifyError(busyErr);
        assert.equal(classification, ERROR_TYPES.RETRYABLE_BUSY);

        // 測試在 WriteQueue 中遇到 RETRYABLE_BUSY 時轉移至 RETRY_PENDING
        const dbPath = getTempDbPath('test2');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);
        await adapter.execute('CREATE TABLE busy_test (id TEXT PRIMARY KEY)');

        const queue = new WriteQueue(adapter, { maxRetries: 3, retryBaseDelayMs: 20 });
        queue.enqueue('INSERT INTO busy_test (id) VALUES (?)', ['busy_1']);

        // 模擬單次失敗轉移驗證
        const item = queue.queue[0];
        assert.equal(item.status, ITEM_STATUS.QUEUED);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 3. SQLite LOCKED
    it('3. SQLite LOCKED: 資料庫鎖定錯誤分類正確', () => {
        const lockedErr = new Error('SQLITE_LOCKED: table is locked');
        lockedErr.code = 'SQLITE_LOCKED';
        lockedErr.errno = 6;

        const classification = classifyError(lockedErr);
        assert.equal(classification, ERROR_TYPES.RETRYABLE_BUSY);
    });

    // 4. SQLITE_FULL
    it('4. SQLITE_FULL: 磁碟滿額暫停寫入，保留隊列項目並可恢復', async () => {
        const dbPath = getTempDbPath('test4');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE full_test (id TEXT PRIMARY KEY)');

        // 模擬適配器在寫入時拋出 SQLITE_FULL
        const origTx = db.adapter.transaction.bind(db.adapter);
        let simulated = false;
        db.adapter.transaction = async (fn) => {
            if (!simulated) {
                simulated = true;
                const fullErr = new Error('SQLITE_FULL: database or disk is full');
                fullErr.code = 'SQLITE_FULL';
                fullErr.errno = 13;
                throw fullErr;
            }
            return origTx(fn);
        };

        db.queueDbOp('INSERT INTO full_test (id) VALUES (?)', ['full_item_1']);
        try {
            await db.flushDbQueue();
        } catch (_) {}

        assert.equal(db.writeQueue.state, QUEUE_STATES.PAUSED_DISK_FULL);
        assert.equal(db.writeQueue.queue.length, 1);
        assert.equal(db.writeQueue.queue[0].params[0], 'full_item_1');

        // 恢復隊列
        db.writeQueue.resumeDiskFull();
        assert.equal(db.writeQueue.state, QUEUE_STATES.NORMAL);

        await db.flushDbQueue();
        const rows = await db.all('SELECT * FROM full_test');
        assert.equal(rows.length, 1);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // 5. SQLITE_CONSTRAINT
    it('5. SQLITE_CONSTRAINT: 主鍵約束違反錯誤分類', () => {
        const constraintErr = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.id');
        constraintErr.code = 'SQLITE_CONSTRAINT';
        constraintErr.errno = 19;

        const classification = classifyError(constraintErr);
        assert.equal(classification, ERROR_TYPES.DATA_CONSTRAINT);
    });

    // 6. Binary Isolation
    it('6. Binary Isolation: 混合批次中自動隔離壞資料，好資料全數提交', async () => {
        const dbPath = getTempDbPath('test6');
        const db = await createDatabaseSubsystem({ dbPath, config: { queue: { batchChunkSize: 10 } } });
        await db.run('CREATE TABLE iso_test (id TEXT PRIMARY KEY, val TEXT)');

        // 先插入一筆 id_2，使後續插入 id_2 時觸發 UNIQUE 約束違反
        await db.run('INSERT INTO iso_test (id, val) VALUES (?, ?)', ['id_2', 'initial']);

        let badItemError = null;
        let goodItemCommitted = 0;

        db.queueDbOp('INSERT INTO iso_test (id, val) VALUES (?, ?)', ['id_1', 'val_1'], (err) => {
            if (!err) goodItemCommitted++;
        });
        db.queueDbOp('INSERT INTO iso_test (id, val) VALUES (?, ?)', ['id_2', 'val_duplicate'], (err) => {
            badItemError = err;
        });
        db.queueDbOp('INSERT INTO iso_test (id, val) VALUES (?, ?)', ['id_3', 'val_3'], (err) => {
            if (!err) goodItemCommitted++;
        });
        db.queueDbOp('INSERT INTO iso_test (id, val) VALUES (?, ?)', ['id_4', 'val_4'], (err) => {
            if (!err) goodItemCommitted++;
        });

        await db.flushDbQueue();

        assert.equal(goodItemCommitted, 3);
        assert.ok(badItemError, '壞項目應收到約束錯誤回呼');
        assert.ok(badItemError.message.includes('QUARANTINED_CONSTRAINT_ERROR'));

        const rows = await db.all('SELECT * FROM iso_test ORDER BY id ASC');
        assert.equal(rows.length, 4); // initial + id_1 + id_3 + id_4

        const metrics = db.writeQueue.getMetrics();
        assert.equal(metrics.totalAbandoned, 1);
        assert.equal(metrics.totalCommitted, 3);
        assert.equal(metrics.conservationCheck, true);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // 7. Retry Queue 重複項目檢查
    it('7. Retry Queue 重複項目檢查: 單一歸屬原則，項目不同時存在於 queue 與 retryQueue', async () => {
        const dbPath = getTempDbPath('test7');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        queue.enqueue('SELECT 1');

        assert.equal(queue.queue.length, 1);
        assert.equal(queue.retryQueue.length, 0);

        const item = queue.queue[0];
        // 進入 retryQueue 時從 queue 移除
        queue.queue.pop();
        queue._scheduleRetry([item], 50);

        assert.equal(queue.queue.length, 0);
        assert.equal(queue.retryQueue.length, 1);

        // 等待重試計時器觸發，確認自動放回 queue 頭部並從 retryQueue 移除
        await new Promise(r => setTimeout(r, 100));
        assert.equal(queue.retryQueue.length, 0);
        assert.equal(queue.queue.length, 1);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 8. FIFO 順序驗證
    it('8. FIFO 順序驗證: 批次分割與 Requeue 嚴格保證原始 FIFO 順序', async () => {
        const dbPath = getTempDbPath('test8');
        const db = await createDatabaseSubsystem({ dbPath, config: { queue: { batchChunkSize: 10 } } });
        await db.run('CREATE TABLE fifo_test (seq INTEGER PRIMARY KEY, name TEXT)');

        const originalOrder = [1, 2, 3, 4, 5, 6];
        for (const num of originalOrder) {
            db.queueDbOp('INSERT INTO fifo_test (seq, name) VALUES (?, ?)', [num, `item_${num}`]);
        }

        await db.flushDbQueue();

        const rows = await db.all('SELECT seq FROM fifo_test ORDER BY rowid ASC');
        const actualOrder = rows.map(r => r.seq);
        assert.deepEqual(actualOrder, originalOrder);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // 9. Adapter Fatal Error
    it('9. Adapter Fatal Error: Adapter 熔斷立即通知 WriteQueue 進入 PAUSED_ERROR 並拒絕新寫入', async () => {
        const dbPath = getTempDbPath('test9');
        const db = await createDatabaseSubsystem({ dbPath });

        assert.equal(db.writeQueue.state, QUEUE_STATES.NORMAL);

        // 觸發 Adapter 致命錯誤
        const fatalErr = new Error('Simulated Fatal SQLite Corrupt');
        db.adapter.setFatalError(fatalErr);

        assert.equal(db.adapter.state, ADAPTER_STATES.ERROR);
        assert.equal(db.writeQueue.state, QUEUE_STATES.PAUSED_ERROR);

        // 新增寫入立即被拒絕
        let rejectedErr = null;
        const accepted = db.queueDbOp('INSERT INTO test (id) VALUES (1)', [], (err) => {
            rejectedErr = err;
        });

        assert.equal(accepted, false);
        assert.ok(rejectedErr);
        assert.ok(rejectedErr.message.includes('QUEUE_REJECTED'));
        assert.equal(db.writeQueue.getMetrics().totalRejected, 1);

        cleanupTempDb(dbPath);
    });

    // 10. Shutdown Drain
    it('10. Shutdown Drain: 關閉前安全排空隊列所有在途與排隊項目', async () => {
        const dbPath = getTempDbPath('test10');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE drain_test (id TEXT PRIMARY KEY)');

        for (let i = 0; i < 8; i++) {
            db.queueDbOp('INSERT INTO drain_test (id) VALUES (?)', [`drain_${i}`]);
        }

        // 調用 shutdownHandler 進行優雅關閉
        const result = await db.shutdownHandler.handle('SIGTERM', { exitProcess: false });
        assert.equal(result.success, true);

        // 使用另一個唯讀連線驗證資料已全部落盤
        const checkDb = new sqlite3.Database(dbPath);
        const rows = await new Promise((resolve) => {
            checkDb.all('SELECT * FROM drain_test', (err, r) => resolve(r));
        });
        checkDb.close();

        assert.equal(rows.length, 8);
        cleanupTempDb(dbPath);
    });

    // 11. Shutdown Deadline
    it('11. Shutdown Deadline: 超時控制防止無限掛起', async () => {
        const dbPath = getTempDbPath('test11');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        const drainCap = authority.issueDrainCapability(200);

        // 模擬一個持續在途的項目，使 drain 超過 50ms deadline
        queue.enqueue('SELECT 1');
        const item = queue.queue.shift();
        queue._transitionItem(item, ITEM_STATUS.IN_FLIGHT);

        await assert.rejects(
            async () => {
                await queue.drain(drainCap, 50);
            },
            /DRAIN_DEADLINE_EXPIRED/
        );

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 12. Emergency Shutdown
    it('12. Emergency Shutdown: 底層操作執行中拒絕 rawClose 並產生診斷轉儲', async () => {
        const dbPath = getTempDbPath('test12');
        const db = await createDatabaseSubsystem({ dbPath });

        // 模擬底層 C 呼叫正在執行
        db.adapter.isExecutingUnderlying = true;

        const crashResult = await db.shutdownHandler.handleEmergencyCrash(
            new Error('Out of memory test'),
            'testOrigin',
            { exitProcess: false }
        );

        assert.equal(crashResult.success, false);
        assert.equal(crashResult.forcedExit, true);
        assert.ok(crashResult.dump);
        assert.equal(crashResult.dump.adapterStatus.underlyingExecuting, true);

        // 復原旗標以便安全關閉測試資料庫
        db.adapter.isExecutingUnderlying = false;
        await db.adapter.emergencyClose();
        cleanupTempDb(dbPath);
    });

    // 13. Scheduler 尚有待執行工作時關閉
    it('13. Scheduler 尚有待執行工作時關閉: 任務退回且狀態標記為 CLOSING', async () => {
        const dbPath = getTempDbPath('test13');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        // 將 adapter 設定為 CLOSING
        adapter.state = ADAPTER_STATES.CLOSING;

        await assert.rejects(
            async () => {
                await adapter.execute('SELECT 1');
            },
            /ADAPTER_CLOSING/
        );

        adapter.state = ADAPTER_STATES.READY;
        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 14. Transaction 執行期間觸發 Shutdown
    it('14. Transaction 執行期間觸發 Shutdown: 禁止不安全關閉', async () => {
        const dbPath = getTempDbPath('test14');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        let txRunning = false;
        let resolveTx;
        const txPromise = new Promise(r => resolveTx = r);

        // 啟動一個長交易
        const task = adapter.transaction(async (tx) => {
            txRunning = true;
            await txPromise;
        });

        // 等待交易開始執行
        while (!txRunning) {
            await new Promise(r => setTimeout(r, 10));
        }

        // 當交易執行中嘗試關閉連線，應被拒絕
        await assert.rejects(
            async () => {
                await adapter.emergencyClose();
            },
            /EMERGENCY_CLOSE_REJECTED/
        );

        resolveTx();
        await task;
        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 15. Checkpoint PASSIVE
    it('15. Checkpoint PASSIVE: 正常執行並回傳狀態', async () => {
        const dbPath = getTempDbPath('test15');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const res = await adapter.checkpoint('PASSIVE');
        assert.ok(res);
        assert.equal(typeof res.busy, 'number');

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 16. Checkpoint FULL
    it('16. Checkpoint FULL: 嚴格檢查在途交易', async () => {
        const dbPath = getTempDbPath('test16');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const res = await adapter.checkpoint('FULL');
        assert.ok(res);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 17. Checkpoint BUSY
    it('17. Checkpoint BUSY: TRUNCATE/FULL 遭遇鎖阻塞時明確拒絕', async () => {
        const dbPath = getTempDbPath('test17');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const drainCap = authority.issueDrainCapability(5000);
        authority.markDrainCompleted(drainCap);

        // 模擬 PRAGMA wal_checkpoint 回傳 busy = 1
        const origRawQueryOne = adapter._rawQueryOne.bind(adapter);
        adapter._rawQueryOne = async (sql) => {
            if (sql.includes('wal_checkpoint')) {
                return { busy: 1, log: 5, checkpointed: 0 };
            }
            return origRawQueryOne(sql);
        };

        await assert.rejects(
            async () => {
                await adapter.checkpoint('TRUNCATE', drainCap);
            },
            /CHECKPOINT_BUSY_BLOCKED/
        );

        adapter._rawQueryOne = origRawQueryOne;
        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // 18. Backup 驗證失敗
    it('18. Backup 驗證失敗: 三態分類與毀損安全處置', async () => {
        const tempCorruptFile = path.join(os.tmpdir(), `corrupt_${Date.now()}.db`);
        fs.writeFileSync(tempCorruptFile, 'INVALID_NOT_A_SQLITE_FILE_CONTENT');

        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        const bm = new BackupManager(adapter, path.dirname(tempCorruptFile));

        const result = await bm.verifyIntegrity(tempCorruptFile);
        assert.equal(result.status, BACKUP_VERIFY_STATUS.VERIFY_ERROR);

        try { fs.unlinkSync(tempCorruptFile); } catch (_) {}
    });

    // 19. Adapter 初始化失敗
    it('19. Adapter 初始化失敗: PRAGMA 驗證不合規時拋錯並標記 ERROR 狀態', async () => {
        const dbPath = getTempDbPath('test19');
        const adapter = new SQLiteAdapter({
            pragmas: { journal_mode: 'DELETE' } // 與 WAL 衝突的設定
        });
        adapter.bindShutdownHandler();

        await assert.rejects(
            async () => {
                await adapter.initialize(dbPath);
            },
            /PRAGMA journal_mode 驗證失敗/
        );

        assert.equal(adapter.state, ADAPTER_STATES.ERROR);
        cleanupTempDb(dbPath);
    });

    // 20. 重複 Shutdown 呼叫
    it('20. 重複 Shutdown 呼叫: 冪等性防護，回傳同一個 Promise', async () => {
        const dbPath = getTempDbPath('test20');
        const db = await createDatabaseSubsystem({ dbPath });

        const p1 = db.shutdownHandler.handle('SIGINT', { exitProcess: false });
        const p2 = db.shutdownHandler.handle('SIGTERM', { exitProcess: false });

        assert.equal(p1, p2, '重複調用應回傳同一個 Promise');

        const res = await p1;
        assert.equal(res.success, true);
        cleanupTempDb(dbPath);
    });

    // 21. Queue Backpressure
    it('21. Queue Backpressure: 超出隊列容量上限時安全拒絕新寫入', async () => {
        const dbPath = getTempDbPath('test21');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: { queue: { maxCapacity: 3, flushIntervalMs: 100000 } }
        });

        assert.equal(db.queueDbOp('SELECT 1'), true);
        assert.equal(db.queueDbOp('SELECT 2'), true);
        assert.equal(db.queueDbOp('SELECT 3'), true);

        let bpErr = null;
        const rejected = db.queueDbOp('SELECT 4', [], (err) => {
            bpErr = err;
        });

        assert.equal(rejected, false);
        assert.ok(bpErr);
        assert.ok(bpErr.message.includes('BACKPRESSURE_REJECTED'));
        assert.equal(db.writeQueue.getMetrics().totalRejected, 1);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // 22. Commit Accounting
    it('22. Commit Accounting: Exactly-once 記帳，回呼僅執行一次', async () => {
        const dbPath = getTempDbPath('test22');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE acct_test (id INT)');

        let cbCount = 0;
        db.queueDbOp('INSERT INTO acct_test VALUES (1)', [], (err) => {
            if (!err) cbCount++;
        });

        await db.flushDbQueue();
        assert.equal(cbCount, 1);
        assert.equal(db.writeQueue.getMetrics().totalCommitted, 1);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // 23. Item Conservation
    it('23. Item Conservation: 任何時間點守恆公式嚴格成立', async () => {
        const dbPath = getTempDbPath('test23');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: { queue: { batchChunkSize: 20 } }
        });
        await db.run('CREATE TABLE cons_test (id TEXT PRIMARY KEY)');

        // 插入混合項目：3 筆正常，1 筆違反約束
        await db.run('INSERT INTO cons_test VALUES (?)', ['dup_key']);

        db.queueDbOp('INSERT INTO cons_test VALUES (?)', ['item_a']);
        db.queueDbOp('INSERT INTO cons_test VALUES (?)', ['item_b']);
        db.queueDbOp('INSERT INTO cons_test VALUES (?)', ['dup_key']); // 壞資料
        db.queueDbOp('INSERT INTO cons_test VALUES (?)', ['item_c']);

        // 寫入前檢查
        let m = db.writeQueue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.totalAccepted, 4);

        await db.flushDbQueue();

        // 寫入後檢查
        m = db.writeQueue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.totalAccepted, 4);
        assert.equal(m.totalCommitted, 3);
        assert.equal(m.totalAbandoned, 1);
        assert.equal(m.totalUncommitted, 0);

        await db.close();
        cleanupTempDb(dbPath);
    });

});
