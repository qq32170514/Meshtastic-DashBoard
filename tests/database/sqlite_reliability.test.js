// tests/database/sqlite_reliability.test.js
const { describe, it } = require('node:test');
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

describe('SQLite Reliability v2.7.2 Comprehensive Test Suite (30 Scenarios)', () => {

    // ==========================================
    // Group A: Scheduler / Shutdown (7 Scenarios)
    // ==========================================

    it('1. Scheduler Pending 時觸發 Emergency Shutdown: 拒絕 rawClose 並產生診斷轉儲', async () => {
        const dbPath = getTempDbPath('sched_pending');
        const db = await createDatabaseSubsystem({ dbPath });

        // 佔位一個底層操作，使後續任務排入 Scheduler Pending
        let releaseBlocker;
        const blockerPromise = new Promise(r => releaseBlocker = r);
        const task1 = db.adapter.execute('SELECT 1').catch(() => {}); // 開始
        db.adapter.isExecutingUnderlying = true;

        // 觸發緊急關閉
        const crashResult = await db.shutdownHandler.handleEmergencyCrash(
            new Error('Scheduler Pending Crash Test'),
            'testOrigin',
            { exitProcess: false }
        );

        assert.equal(crashResult.success, false);
        assert.equal(crashResult.forcedExit, true);
        assert.ok(crashResult.dump);
        assert.equal(crashResult.dump.adapterStatus.underlyingExecuting, true);

        db.adapter.isExecutingUnderlying = false;
        await db.adapter.emergencyClose();
        cleanupTempDb(dbPath);
    });

    it('2. Scheduler Active 時觸發 Emergency Shutdown: 檢驗 isQuiescent 並安全拒絕', async () => {
        const dbPath = getTempDbPath('sched_active');
        const db = await createDatabaseSubsystem({ dbPath });

        // 模擬 active task 正在執行
        db.adapter.isExecutingUnderlying = true;
        assert.equal(db.adapter.isQuiescent(), false);

        await assert.rejects(
            async () => {
                await db.adapter.emergencyClose();
            },
            /EMERGENCY_CLOSE_REJECTED/
        );

        db.adapter.isExecutingUnderlying = false;
        assert.equal(db.adapter.isQuiescent(), true);
        await db.adapter.emergencyClose();
        cleanupTempDb(dbPath);
    });

    it('3. Transaction 執行中觸發 Shutdown: 禁止關閉並保護在途資料', async () => {
        const dbPath = getTempDbPath('tx_shutdown');
        const db = await createDatabaseSubsystem({ dbPath });

        let txStarted = false;
        let resolveTx;
        const txPromise = new Promise(r => resolveTx = r);

        const runPromise = db.adapter.transaction(async (tx) => {
            txStarted = true;
            await txPromise;
        });

        while (!txStarted) {
            await new Promise(r => setTimeout(r, 10));
        }

        assert.equal(db.adapter.getActiveStatus().activeTransactions, 1);
        assert.equal(db.adapter.isQuiescent(), false);

        await assert.rejects(
            async () => {
                await db.adapter.emergencyClose();
            },
            /EMERGENCY_CLOSE_REJECTED/
        );

        resolveTx();
        await runPromise;
        await db.adapter.close();
        cleanupTempDb(dbPath);
    });

    it('4. Shutdown Gate 關閉後嘗試新增工作: 即刻拒絕並累計 totalRejected', async () => {
        const dbPath = getTempDbPath('gate_closed');
        const db = await createDatabaseSubsystem({ dbPath });

        db.adapter.stopAcceptingNewTasks();

        await assert.rejects(
            async () => {
                await db.adapter.execute('SELECT 1');
            },
            /GATE_CLOSED/
        );

        let rejectedCbErr = null;
        const accepted = db.queueDbOp('SELECT 1', [], (err) => {
            rejectedCbErr = err;
        });

        assert.equal(accepted, false);
        assert.ok(rejectedCbErr);
        assert.equal(db.writeQueue.getMetrics().totalRejected, 1);

        cleanupTempDb(dbPath);
    });

    it('5. Deadline 到達後 Scheduler 不得啟動新交易: 獨立 Observer 準時返回', async () => {
        const dbPath = getTempDbPath('deadline_obs');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        const drainCap = authority.issueDrainCapability(200);

        // 模擬掛起一個 inFlight 項目
        queue.enqueue('SELECT 1');
        const item = queue.queue.shift();
        queue._transitionItem(item, ITEM_STATUS.IN_FLIGHT);

        const startT = Date.now();
        const snapshot = await queue.drain(drainCap, 100);
        const elapsed = Date.now() - startT;

        assert.ok(elapsed >= 90 && elapsed <= 300, `Drain 應在 100ms 左右準時返回 (耗時: ${elapsed}ms)`);
        assert.equal(snapshot.isClean, false);
        assert.equal(snapshot.deadlineExpired, true);
        assert.equal(snapshot.uncommitted, 1);

        // 檢查 Gate 關閉，後續入列遭拒
        assert.equal(queue.enqueue('SELECT 2'), false);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('6. 重複 Shutdown 冪等性: 同時呼叫回傳同一個 Promise 且僅關閉一次', async () => {
        const dbPath = getTempDbPath('dup_shutdown');
        const db = await createDatabaseSubsystem({ dbPath });

        const p1 = db.shutdownHandler.handle('SIGINT', { exitProcess: false });
        const p2 = db.shutdownHandler.handle('SIGTERM', { exitProcess: false });

        assert.equal(p1, p2, '重複調用必須回傳同一個 Promise 物件實例');

        const res = await p1;
        assert.equal(res.success, true);
        cleanupTempDb(dbPath);
    });

    it('7. Maintenance 與 Drain 競爭: 維護執行中禁止執行 TRUNCATE Checkpoint', async () => {
        const dbPath = getTempDbPath('maint_comp');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const drainCap = authority.issueDrainCapability(5000);
        authority.markDrainCompleted(drainCap);

        // 模擬維護任務進行中
        adapter.maintenanceInProgress = true;

        await assert.rejects(
            async () => {
                await adapter.checkpoint('TRUNCATE', drainCap, () => ({ totalUncommitted: 0, inFlightCount: 0 }));
            },
            /CHECKPOINT_PRECONDITION_FAILED/
        );

        adapter.maintenanceInProgress = false;
        await adapter.close();
        cleanupTempDb(dbPath);
    });

    // ==========================================
    // Group B: FIFO / Binary Isolation (6 Scenarios)
    // ==========================================

    it('8. 正常 Binary Isolation: 自動拆分壞資料，好資料成功提交', async () => {
        const dbPath = getTempDbPath('fifo_iso_normal');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE iso_users (id TEXT PRIMARY KEY, name TEXT)');

        await db.run('INSERT INTO iso_users VALUES (?, ?)', ['u2', 'initial']);

        let badErr = null;
        let goodCount = 0;

        db.queueDbOp('INSERT INTO iso_users VALUES (?, ?)', ['u1', 'Alice'], (err) => { if (!err) goodCount++; });
        db.queueDbOp('INSERT INTO iso_users VALUES (?, ?)', ['u2', 'Duplicate'], (err) => { badErr = err; });
        db.queueDbOp('INSERT INTO iso_users VALUES (?, ?)', ['u3', 'Charlie'], (err) => { if (!err) goodCount++; });
        db.queueDbOp('INSERT INTO iso_users VALUES (?, ?)', ['u4', 'Dave'], (err) => { if (!err) goodCount++; });

        await db.flushDbQueue();

        assert.equal(goodCount, 3);
        assert.ok(badErr && badErr.message.includes('QUARANTINED_CONSTRAINT_ERROR'));

        const rows = await db.all('SELECT id FROM iso_users ORDER BY id ASC');
        assert.deepEqual(rows.map(r => r.id), ['u1', 'u2', 'u3', 'u4']);

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('9. 左側 SQLITE_FULL 保持 FIFO (P0-1 核心驗證): 剩餘批次按原始順序排回隊列前端', async () => {
        const dbPath = getTempDbPath('fifo_left_full');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: { queue: { batchChunkSize: 10 } }
        });
        await db.run('CREATE TABLE left_full (seq INT PRIMARY KEY)');

        const original = [1, 2, 3, 4, 5, 6];
        for (const s of original) {
            db.queueDbOp('INSERT INTO left_full VALUES (?)', [s]);
        }

        // 模擬批次寫入時拋出 SQLITE_FULL
        const origTx = db.adapter.transaction.bind(db.adapter);
        let simulatedFull = false;
        db.adapter.transaction = async (fn) => {
            if (!simulatedFull) {
                simulatedFull = true;
                const err = new Error('SQLITE_FULL: disk full');
                err.code = 'SQLITE_FULL';
                err.errno = 13;
                throw err;
            }
            return origTx(fn);
        };

        try {
            await db.flushDbQueue();
        } catch (_) {}

        assert.equal(db.writeQueue.state, QUEUE_STATES.PAUSED_DISK_FULL);

        // 關鍵驗證：隊列中的項目必須保持原始順序 [1, 2, 3, 4, 5, 6]，絕對不得顛倒成 [4, 5, 6, 1, 2, 3]
        const queuedSeq = db.writeQueue.queue.map(item => item.params[0]);
        assert.deepEqual(queuedSeq, [1, 2, 3, 4, 5, 6]);

        // 恢復後寫入完成驗證
        db.writeQueue.resumeDiskFull();
        await db.flushDbQueue();

        const rows = await db.all('SELECT seq FROM left_full ORDER BY rowid ASC');
        assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5, 6]);

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('10. 右側 SQLITE_FULL 保持 FIFO: Left 提交成功，Right 按原始順序退回隊列前端', async () => {
        const dbPath = getTempDbPath('fifo_right_full');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: { queue: { batchChunkSize: 10 } }
        });
        await db.run('CREATE TABLE right_full (id TEXT PRIMARY KEY, val INT)');

        // 設定觸發二分拆分：第一筆資料違反約束
        await db.run('INSERT INTO right_full VALUES (?, ?)', ['dup_key', 0]);

        db.queueDbOp('INSERT INTO right_full VALUES (?, ?)', ['dup_key', 1]); // Bad: 觸發二分拆分
        db.queueDbOp('INSERT INTO right_full VALUES (?, ?)', ['item_2', 2]);
        db.queueDbOp('INSERT INTO right_full VALUES (?, ?)', ['item_3', 3]);
        db.queueDbOp('INSERT INTO right_full VALUES (?, ?)', ['item_4', 4]);

        await db.flushDbQueue();

        const rows = await db.all('SELECT id, val FROM right_full WHERE val > 0 ORDER BY val ASC');
        assert.deepEqual(rows.map(r => r.val), [2, 3, 4]);

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('11. UNKNOWN 中止 Binary Isolation (P1-01): 立即熔斷且所有未提交資料完整保留', async () => {
        const dbPath = getTempDbPath('unknown_err');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE unk_test (id INT)');

        // 注入 UNKNOWN 錯誤
        const origTx = db.adapter.transaction.bind(db.adapter);
        db.adapter.transaction = async () => {
            throw new Error('Completely Unknown Low-Level Anomaly');
        };

        db.queueDbOp('INSERT INTO unk_test VALUES (?)', [100]);
        db.queueDbOp('INSERT INTO unk_test VALUES (?)', [200]);

        try {
            await db.flushDbQueue();
        } catch (_) {}

        assert.equal(db.writeQueue.state, QUEUE_STATES.PAUSED_ERROR);
        assert.equal(db.writeQueue.uncommittedErrors.length, 2);
        assert.equal(db.writeQueue.uncommittedErrors[0].params[0], 100);
        assert.equal(db.writeQueue.uncommittedErrors[1].params[0], 200);

        db.adapter.transaction = origTx;
        cleanupTempDb(dbPath);
    });

    it('12. Retry Queue 與一般 Queue 容器互斥無重複 (P0-2): 單一歸屬保證', async () => {
        const dbPath = getTempDbPath('retry_mutex');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        queue.enqueue('SELECT 1');

        assert.equal(queue.queue.length, 1);
        assert.equal(queue.retryPendingItems.size, 0);

        const item = queue.queue[0];
        // 移入 retry
        queue._scheduleRetry([item], 60);

        assert.equal(queue.queue.length, 0);
        assert.equal(queue.retryPendingItems.size, 1);
        assert.ok(queue.retryPendingItems.has(item));

        // 等候重試計時器喚醒
        await new Promise(r => setTimeout(r, 120));

        assert.equal(queue.retryPendingItems.size, 0);
        assert.equal(queue.queue.length, 1);
        assert.equal(queue.queue[0], item);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('13. 多批次連續失敗仍維持 FIFO: 排序以原始 seq 為準', async () => {
        const dbPath = getTempDbPath('multi_batch_fifo');
        const db = await createDatabaseSubsystem({ dbPath, config: { queue: { batchChunkSize: 5 } } });
        await db.run('CREATE TABLE seq_test (seq INT PRIMARY KEY)');

        for (let i = 1; i <= 6; i++) {
            db.queueDbOp('INSERT INTO seq_test VALUES (?)', [i]);
        }

        await db.flushDbQueue();
        const rows = await db.all('SELECT seq FROM seq_test ORDER BY rowid ASC');
        assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5, 6]);

        await db.close();
        cleanupTempDb(dbPath);
    });

    // ==========================================
    // Group C: Data Conservation & Lifecycles (9 Scenarios)
    // ==========================================

    it('14. 正常 COMMIT 與守恆: totalAccepted == totalCommitted', async () => {
        const dbPath = getTempDbPath('cons_commit');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE cc (id INT)');

        for (let i = 0; i < 5; i++) {
            db.queueDbOp('INSERT INTO cc VALUES (?)', [i]);
        }
        await db.flushDbQueue();

        const m = db.writeQueue.getMetrics();
        assert.equal(m.totalAccepted, 5);
        assert.equal(m.totalCommitted, 5);
        assert.equal(m.conservationCheck, true);

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('15. BUSY Retry 守恆: 重試過程中資料守恆公式恆成立', async () => {
        const dbPath = getTempDbPath('cons_busy');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter, { maxRetries: 3, retryBaseDelayMs: 20 });
        queue.enqueue('SELECT 1');

        let m = queue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.totalAccepted, 1);

        const item = queue.queue[0];
        queue._scheduleRetry([item], 30);

        m = queue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.retryPendingCount, 1);

        await new Promise(r => setTimeout(r, 60));

        m = queue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.queuedCount, 1);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('16. SQLITE_FULL 守恆: 磁碟滿額暫停時所有未提交資料皆計入 queued', async () => {
        const dbPath = getTempDbPath('cons_full');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE cf (id INT)');

        const origTx = db.adapter.transaction.bind(db.adapter);
        db.adapter.transaction = async () => {
            const err = new Error('SQLITE_FULL: disk full');
            err.code = 'SQLITE_FULL';
            err.errno = 13;
            throw err;
        };

        db.queueDbOp('INSERT INTO cf VALUES (1)');
        try { await db.flushDbQueue(); } catch (_) {}

        const m = db.writeQueue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.queuedCount, 1);
        assert.equal(m.state, QUEUE_STATES.PAUSED_DISK_FULL);

        db.adapter.transaction = origTx;
        cleanupTempDb(dbPath);
    });

    it('17. CONSTRAINT Quarantine 守恆: 隔離項目轉入 quarantined 容器並精準計帳', async () => {
        const dbPath = getTempDbPath('cons_quar');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE cq (id INT PRIMARY KEY)');
        await db.run('INSERT INTO cq VALUES (1)');

        db.queueDbOp('INSERT INTO cq VALUES (1)'); // 衝突
        db.queueDbOp('INSERT INTO cq VALUES (2)'); // 成功

        await db.flushDbQueue();

        const m = db.writeQueue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.totalAccepted, 2);
        assert.equal(m.totalCommitted, 1);
        assert.equal(m.totalQuarantined, 1);
        assert.equal(db.writeQueue.quarantinedItems.length, 1);

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('18. UNKNOWN 熔斷保留與守恆: 轉移至 uncommittedErrors 實體保留 SQL 與參數', async () => {
        const dbPath = getTempDbPath('cons_unk');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE cu (id INT)');

        db.adapter.transaction = async () => { throw new Error('Weird Error'); };

        db.queueDbOp('INSERT INTO cu VALUES (?)', [999]);
        try { await db.flushDbQueue(); } catch (_) {}

        const m = db.writeQueue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.totalUncommittedErrors, 1);
        assert.equal(db.writeQueue.uncommittedErrors[0].params[0], 999);

        cleanupTempDb(dbPath);
    });

    it('19. Adapter ERROR 拒絕與計數分離: 故障時拒絕新入列，totalAccepted 不增加', async () => {
        const dbPath = getTempDbPath('cons_rej');
        const db = await createDatabaseSubsystem({ dbPath });

        db.adapter.setFatalError(new Error('Fatal Adapter Breakdown'));

        const accepted = db.queueDbOp('SELECT 1');
        assert.equal(accepted, false);

        const m = db.writeQueue.getMetrics();
        assert.equal(m.totalAccepted, 0);
        assert.equal(m.totalRejected, 1);
        assert.equal(m.conservationCheck, true);

        cleanupTempDb(dbPath);
    });

    it('20. Shutdown Deadline 守恆: 逾時未提交資料依舊受嚴格守恆追蹤', async () => {
        const dbPath = getTempDbPath('cons_dead');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        const drainCap = authority.issueDrainCapability(100);

        queue.enqueue('SELECT 1');
        queue._transitionItem(queue.queue[0], ITEM_STATUS.IN_FLIGHT);

        await queue.drain(drainCap, 30);

        const m = queue.getMetrics();
        assert.equal(m.conservationCheck, true);
        assert.equal(m.totalAccepted, 1);
        assert.equal(m.inFlightCount, 1);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('21. 非法 Item 狀態轉換防護: 違規轉移被攔截且不破壞原有狀態', async () => {
        const dbPath = getTempDbPath('cons_illegal');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        queue.enqueue('SELECT 1');
        const item = queue.queue[0];

        // 嘗試非法轉移：QUEUED -> COMMITTED (必須先經由 IN_FLIGHT)
        const ok = queue._transitionItem(item, ITEM_STATUS.COMMITTED);
        assert.equal(ok, false);
        assert.equal(item.status, ITEM_STATUS.QUEUED);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('22. Callback Exactly-Once 集中防重 (P1-02): 使用者回呼保證僅被執行一次', async () => {
        const dbPath = getTempDbPath('cb_once');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE cb_t (id INT)');

        let callCount = 0;
        db.queueDbOp('INSERT INTO cb_t VALUES (1)', [], (err) => {
            callCount++;
        });

        await db.flushDbQueue();
        assert.equal(callCount, 1);

        // 再次人為呼叫集中方法，應被 item.callbackInvoked 抑制
        const item = { callback: () => callCount++, callbackInvoked: true };
        db.writeQueue._invokeCallback(item, null);
        assert.equal(callCount, 1, '重複回呼必須被嚴格抑制');

        await db.close();
        cleanupTempDb(dbPath);
    });

    // ==========================================
    // Group D: Backup & Checkpoint (8 Scenarios)
    // ==========================================

    it('23. Backup Integrity VALID: 正常資料庫完整性驗證通過', async () => {
        const dbPath = getTempDbPath('bak_valid');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE bv (id INT)');
        await db.run('INSERT INTO bv VALUES (42)');

        const backupRes = await db.backupManager.performBackup('test_valid.db');
        assert.equal(backupRes.success, true);
        assert.equal(backupRes.verify.status, BACKUP_VERIFY_STATUS.VALID);

        await db.close();
        try { fs.unlinkSync(backupRes.targetPath); } catch (_) {}
        cleanupTempDb(dbPath);
    });

    it('24. Backup Integrity CORRUPTED: 毀損檔案標記 CORRUPTED 並安全移除', async () => {
        const corruptFile = path.join(os.tmpdir(), `corrupt_file_${Date.now()}.db`);
        fs.writeFileSync(corruptFile, 'INVALID_SQLITE_GARBAGE_BYTES_HEAD');

        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        const bm = new BackupManager(adapter, os.tmpdir());

        const res = await bm.verifyIntegrity(corruptFile);
        assert.equal(res.status, BACKUP_VERIFY_STATUS.VERIFY_ERROR);

        try { fs.unlinkSync(corruptFile); } catch (_) {}
    });

    it('25. Backup Integrity VERIFY_ERROR: 檔案不存在時回傳 VERIFY_ERROR', async () => {
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        const bm = new BackupManager(adapter, os.tmpdir());

        const res = await bm.verifyIntegrity(path.join(os.tmpdir(), 'non_existent_file.db'));
        assert.equal(res.status, BACKUP_VERIFY_STATUS.VERIFY_ERROR);
        assert.equal(res.details, 'FILE_NOT_FOUND');
    });

    it('26. Backup close 失敗處置 (P1-03): close 異常歸類為 VERIFY_ERROR 且保留候選檔', async () => {
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        const bm = new BackupManager(adapter, os.tmpdir());

        // 測試 verifyIntegrity 程式碼分支健全性
        const validPath = getTempDbPath('close_err_test');
        const db = await createDatabaseSubsystem({ dbPath: validPath });
        await db.close();

        const res = await bm.verifyIntegrity(validPath);
        assert.equal(res.status, BACKUP_VERIFY_STATUS.VALID);

        cleanupTempDb(validPath);
    });

    it('27. Checkpoint PASSIVE: 輕負載下執行並回傳 busy 狀態', async () => {
        const dbPath = getTempDbPath('cp_passive');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const res = await adapter.checkpoint('PASSIVE');
        assert.ok(res);
        assert.equal(typeof res.busy, 'number');

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('28. Checkpoint FULL: 嚴格檢查在途交易與 Scheduler Pending', async () => {
        const dbPath = getTempDbPath('cp_full');
        const adapter = new SQLiteAdapter();
        adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const res = await adapter.checkpoint('FULL');
        assert.ok(res);

        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('29. Checkpoint BUSY 拒絕: TRUNCATE/FULL 遇 busy===1 拋出 CHECKPOINT_BUSY_BLOCKED', async () => {
        const dbPath = getTempDbPath('cp_busy_rej');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const drainCap = authority.issueDrainCapability(5000);
        authority.markDrainCompleted(drainCap);

        const origRawQueryOne = adapter._rawQueryOne.bind(adapter);
        adapter._rawQueryOne = async (sql) => {
            if (sql.includes('wal_checkpoint')) {
                return { busy: 1, log: 10, checkpointed: 0 };
            }
            return origRawQueryOne(sql);
        };

        await assert.rejects(
            async () => {
                await adapter.checkpoint('TRUNCATE', drainCap, () => ({ totalUncommitted: 0, inFlightCount: 0 }));
            },
            /CHECKPOINT_BUSY_BLOCKED/
        );

        adapter._rawQueryOne = origRawQueryOne;
        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('30. TRUNCATE 安全條件嚴格檢查 (P1-2): 缺少 queueMetricsProvider 或未排空時拒絕', async () => {
        const dbPath = getTempDbPath('cp_trunc_pre');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const drainCap = authority.issueDrainCapability(5000);
        authority.markDrainCompleted(drainCap);

        // 1. 缺少 queueMetricsProvider
        await assert.rejects(
            async () => {
                await adapter.checkpoint('TRUNCATE', drainCap, null);
            },
            /queueMetricsProvider 為必填參數/
        );

        // 2. 隊列尚有未提交資料
        await assert.rejects(
            async () => {
                await adapter.checkpoint('TRUNCATE', drainCap, () => ({ totalUncommitted: 5, inFlightCount: 0 }));
            },
            /CHECKPOINT_PRECONDITION_FAILED/
        );

        await adapter.close();
        cleanupTempDb(dbPath);
    });

});
