// tests/database/sqlite_reliability.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const {
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

function assertDataConservation(m) {
    const totalPending = m.queuedCount + m.retryPendingCount + m.inFlightCount;
    const totalUncommitted = totalPending + m.uncommittedErrorCount;
    const expectedAccepted = m.totalCommitted + m.totalQuarantined + totalUncommitted;
    assert.equal(
        m.totalAccepted,
        expectedAccepted,
        `Data Conservation 違規! totalAccepted=${m.totalAccepted}, 但 committed(${m.totalCommitted}) + quarantined(${m.totalQuarantined}) + uncommitted(${totalUncommitted}) = ${expectedAccepted}`
    );
}

describe('SQLite Reliability v2.7.7 Comprehensive Test Suite (46 Scenarios)', () => {

    // ==========================================
    // Group A: Scheduler / Shutdown (7 Scenarios)
    // ==========================================

    it('1. Scheduler Pending/Active 時觸發 Emergency Shutdown: 拒絕 rawClose 並產生診斷轉儲 (v2.7.4)', async () => {
        const dbPath = getTempDbPath('sched_pending');
        const db = await createDatabaseSubsystem({ dbPath });

        // 使用真實的 Deferred scheduler task 佔用排程器底層執行
        let releaseTask;
        const deferredTask = new Promise((resolve) => { releaseTask = resolve; });
        const runningTask = db.adapter._schedule(async () => {
            await deferredTask;
        });

        // 等待任務真正被排程器排入並進入執行
        while (!db.adapter.isExecutingUnderlying) {
            await new Promise(r => setTimeout(r, 5));
        }

        // 觸發緊急關閉 (等待 50ms 超時)
        const crashResult = await db.shutdownHandler.handleEmergencyCrash(
            new Error('Scheduler Pending Crash Test'),
            'testOrigin',
            { exitProcess: false }
        );

        assert.equal(crashResult.success, false);
        assert.equal(crashResult.forcedExit, true);
        assert.equal(crashResult.adapterClosed, false);
        assert.ok(crashResult.dump);
        assert.equal(crashResult.dump.adapterStatus.underlyingExecuting, true);

        // 釋放 deferred 任務並完成清理
        releaseTask();
        await runningTask;
        await db.adapter.emergencyClose(1000);
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
                await db.adapter.emergencyClose(1000);
            },
            /EMERGENCY_CLOSE_REJECTED/
        );

        db.adapter.isExecutingUnderlying = false;
        assert.equal(db.adapter.isQuiescent(), true);
        await db.adapter.emergencyClose(1000);
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

    it('5. Deadline 到達後 Scheduler 不得啟動新交易: 獨立 Observer 準時返回 (v2.7.4)', async () => {
        const dbPath = getTempDbPath('deadline_obs');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        await adapter.initialize(dbPath);

        const queue = new WriteQueue(adapter);
        const drainCap = authority.issueDrainCapability(500);

        // 使用真實底層交易且未完成 (Deferred) 模擬真實 inFlight / 底層操作未完成
        let releaseTx;
        const deferredTx = new Promise(resolve => { releaseTx = resolve; });
        const txPromise = adapter.drainTransaction(async () => {
            await deferredTx;
        }, drainCap);

        while (!adapter.isExecutingUnderlying) {
            await new Promise(r => setTimeout(r, 5));
        }

        // 排入一筆待排空寫入，使其在 Drain 時受阻於底層進行中之交易
        queue.enqueue('SELECT 1');

        const startT = Date.now();
        const snapshot = await queue.drain(drainCap, 100);
        const elapsed = Date.now() - startT;

        assert.ok(elapsed >= 90 && elapsed <= 300, `Drain 應在 100ms 左右準時返回 (耗時: ${elapsed}ms)`);
        assert.equal(snapshot.isClean, false);
        assert.equal(snapshot.deadlineExpired, true);
        assert.equal(snapshot.uncommitted, 1);

        // 檢查 Gate 關閉，後續入列遭拒
        assert.equal(queue.enqueue('SELECT 2'), false);

        releaseTx();
        await txPromise;
        while (queue.isFlushing || !adapter.isQuiescent()) {
            await new Promise(r => setTimeout(r, 5));
        }
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

    // ==========================================
    // Group F: SQLite Reliability v2.7.3 Defects & Invariants (7 Scenarios)
    // ==========================================

    it('31. Drain 不將 UNCOMMITTED_ERROR 誤判為成功 (v2.7.3 P0-1)', async () => {
        const dbPath = getTempDbPath('drain_uncommitted_error');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE uncomm_test (id INT)');

        // 模擬一個 UNKNOWN 錯誤使得項目轉移入 uncommittedErrors
        const err = new Error('SQLITE_UNKNOWN_INTERNAL: Unexpected engine fault');
        db.writeQueue.totalAccepted++;
        const badItem = {
            id: crypto.randomUUID(),
            seq: 999,
            sql: 'INSERT INTO uncomm_test VALUES (1)',
            params: [],
            status: ITEM_STATUS.QUEUED,
            attempt: 0,
            callback: null
        };
        db.writeQueue._transitionItem(badItem, ITEM_STATUS.UNCOMMITTED_ERROR, err);

        const m = db.writeQueue.getMetrics();
        assert.equal(m.queuedCount, 0);
        assert.equal(m.retryPendingCount, 0);
        assert.equal(m.inFlightCount, 0);
        assert.equal(m.uncommittedErrorCount, 1);
        assert.equal(m.totalUncommitted, 1);
        assert.equal(m.totalPending, 0);

        // 透過 shutdownHandler.handle 驗收
        const shutResult = await db.shutdownHandler.handle('MANUAL_CLOSE', { exitProcess: false });

        assert.equal(shutResult.success, false);
        assert.equal(shutResult.metrics.totalUncommitted, 1);
        assert.equal(shutResult.metrics.uncommittedErrorCount, 1);

        cleanupTempDb(dbPath);
    });

    it('32. Binary Isolation 部分失敗與剩餘批次原子回退 (v2.7.4 P0-2 / P0-1)', async () => {
        const dbPath = getTempDbPath('top_batch_partial_fail');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE dead_bi (id INT PRIMARY KEY)');

        let txCount = 0;
        const origTx = db.adapter.transaction.bind(db.adapter);
        let triggerDeadlineNow = false;

        db.adapter.transaction = async function(fn) {
            txCount++;
            if (txCount === 1) {
                // 第 1 次整批交易：模擬觸發 DATA_CONSTRAINT 以進入 Binary Isolation 拆分
                const constraintErr = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: dead_bi.id');
                constraintErr.code = 'SQLITE_CONSTRAINT';
                throw constraintErr;
            }
            if (txCount === 2) {
                // 第 2 次交易：正常提交 Left 子批次 (包含 id: 1)
                const res = await origTx(fn);
                // Left 完成後，立即模擬 Deadline 到達
                triggerDeadlineNow = true;
                return res;
            }
            // 第 3 次交易（Right 子批次）：應在進入交易前被 Deadline Gate 嚴格阻止
            return origTx(fn);
        };

        const origDateNow = Date.now;
        const origDeadline = origDateNow() + 1000;
        Date.now = function() {
            if (triggerDeadlineNow) {
                return origDeadline + 5000; // deadline expired!
            }
            return origDateNow();
        };

        const item1 = { id: '1', seq: 1, sql: 'INSERT INTO dead_bi VALUES (1)', params: [], status: ITEM_STATUS.QUEUED, attempt: 0 };
        const item2 = { id: '2', seq: 2, sql: 'INSERT INTO dead_bi VALUES (2)', params: [], status: ITEM_STATUS.QUEUED, attempt: 0 };
        db.writeQueue.totalAccepted = 2;
        db.writeQueue._transitionItem(item1, ITEM_STATUS.IN_FLIGHT);
        db.writeQueue._transitionItem(item2, ITEM_STATUS.IN_FLIGHT);

        try {
            // 🌟 透過最外層控制流程 _executeTopLevelBatch 測試 partial failure 處理
            await assert.rejects(
                async () => {
                    await db.writeQueue._executeTopLevelBatch([item1, item2], null, origDeadline);
                },
                /DEADLINE_EXPIRED/
            );

            // 驗證：僅啟動了 2 次交易 (1: 整批觸發拆分, 2: Left 提交 item1)，Right 子批次交易絕對沒有啟動！
            assert.equal(txCount, 2);
            // 驗證 item1 成功提交，item2 被原子排回 queue 前端
            assert.equal(item1.status, ITEM_STATUS.COMMITTED);
            assert.equal(db.writeQueue.queue.length, 1);
            assert.equal(db.writeQueue.queue[0].id, '2');
            assert.equal(db.writeQueue.queue[0].status, ITEM_STATUS.QUEUED);

            const row = await db.get('SELECT id FROM dead_bi WHERE id = 1');
            assert.ok(row);
            const row2 = await db.get('SELECT id FROM dead_bi WHERE id = 2');
            assert.equal(row2, null);

            // 驗證 Data Conservation: totalAccepted (2) = totalCommitted (1) + queued (1)
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            Date.now = origDateNow;
            db.adapter.transaction = origTx;
            await db.close();
            cleanupTempDb(dbPath);
        }
    });

    it('33. 故障注入測試 (Fault Injection): 模擬 SQLITE_FULL 時 Drain 立即中止且不無限重試 (v2.7.3 P0-3)', async () => {
        // 故障注入測試：透過 monkeypatch 模擬底層回報 SQLITE_FULL 錯誤以驗證排空熔斷邏輯
        const dbPath = getTempDbPath('drain_disk_full_stop');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE df_test (id INT)');

        let txAttempts = 0;
        const origTx = db.adapter.drainTransaction.bind(db.adapter);
        db.adapter.drainTransaction = async function(fn, cap) {
            txAttempts++;
            const fullErr = new Error('database or disk is full');
            fullErr.code = 'SQLITE_FULL';
            throw fullErr;
        };

        for (let i = 0; i < 3; i++) {
            db.queueDbOp('INSERT INTO df_test VALUES (?)', [i]);
        }

        const drainCap = { id: crypto.randomUUID() };
        // 執行 drain，應該在第一次遭遇 SQLITE_FULL 後立即終止，而不是重試到 3000ms 超時
        const startTime = Date.now();
        const result = await db.writeQueue.drain(drainCap, 3000);
        const elapsed = Date.now() - startTime;

        assert.equal(result.isDiskFull, true);
        assert.equal(result.isClean, false);
        // 驗證 Worker 在第一次失敗後立即 break，沒有進行無限重試
        assert.equal(txAttempts, 1);
        // 驗證耗時遠小於 3000ms deadline（即時中斷退出）
        assert.ok(elapsed < 2000, `耗時過長: ${elapsed}ms`);

        // 驗證資料仍完整保留在隊列中
        assert.equal(db.writeQueue.queue.length, 3);
        assert.equal(db.writeQueue.state, QUEUE_STATES.PAUSED_DISK_FULL);

        db.adapter.drainTransaction = origTx;
        cleanupTempDb(dbPath);
    });

    it('34. PAUSED_DISK_FULL 狀態下拒絕新寫入 (v2.7.3 P1-1)', async () => {
        const dbPath = getTempDbPath('paused_disk_full_reject');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE df_rej (id INT)');

        // 人工將佇列切入 PAUSED_DISK_FULL
        db.writeQueue.state = QUEUE_STATES.PAUSED_DISK_FULL;

        const initialAccepted = db.writeQueue.getMetrics().totalAccepted;
        const initialRejected = db.writeQueue.getMetrics().totalRejected;

        let cbErr = null;
        const accepted = db.queueDbOp('INSERT INTO df_rej VALUES (1)', [], (err) => {
            cbErr = err;
        });

        assert.equal(accepted, false);
        assert.ok(cbErr);
        assert.match(cbErr.message, /磁碟滿額暫停/);
        assert.equal(db.writeQueue.getMetrics().totalRejected, initialRejected + 1);
        assert.equal(db.writeQueue.getMetrics().totalAccepted, initialAccepted);
        assert.equal(db.writeQueue.queue.length, 0);

        // 恢復磁碟滿額
        db.writeQueue.resumeDiskFull();
        assert.equal(db.writeQueue.state, QUEUE_STATES.NORMAL);

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('35. PRAGMA 動態比對與硬性驗證 (v2.7.3 P1-2)', async () => {
        const dbPath = getTempDbPath('pragma_verify');
        // 測試正常初始化讀回一致性
        const db = await createDatabaseSubsystem({ dbPath });

        const j = await db.get('PRAGMA journal_mode');
        assert.equal(String(j.journal_mode).toLowerCase(), 'wal');

        const s = await db.get('PRAGMA synchronous');
        assert.equal(Number(s.synchronous), 1); // NORMAL is 1

        const b = await db.get('PRAGMA busy_timeout');
        assert.equal(Number(b.timeout), 10000);

        const f = await db.get('PRAGMA foreign_keys');
        assert.equal(Number(f.foreign_keys), 0); // OFF is 0

        const w = await db.get('PRAGMA wal_autocheckpoint');
        assert.equal(Number(w.wal_autocheckpoint), 1000);

        await db.close();

        // 測試 PRAGMA 設定不符時拋出 HARD_FAIL 且 Adapter 進入 ERROR 狀態
        const badAdapter = new SQLiteAdapter({
            pragmas: {
                journal_mode: 'INVALID_MODE'
            }
        });
        await assert.rejects(
            async () => {
                await badAdapter.initialize(getTempDbPath('pragma_bad'));
            },
            /HARD_FAIL.*PRAGMA journal_mode/
        );
        assert.equal(badAdapter.state, ADAPTER_STATES.ERROR);

        cleanupTempDb(dbPath);
    });

    it('36. Callback Exactly-Once 相容層防重調用 (v2.7.3 P1-3)', async () => {
        const dbPath = getTempDbPath('compat_callback_once');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE cb_test (id INT PRIMARY KEY, val TEXT)');

        // 1. run 成功，但 callback 內部自行拋出例外
        let runCbCount = 0;
        await assert.rejects(
            async () => {
                await db.run('INSERT INTO cb_test VALUES (1, "a")', (err) => {
                    runCbCount++;
                    throw new Error('Callback User Exception');
                });
            },
            /Callback User Exception/
        );
        assert.equal(runCbCount, 1);

        // 2. get 成功，callback 內部拋出例外
        let getCbCount = 0;
        await assert.rejects(
            async () => {
                await db.get('SELECT * FROM cb_test WHERE id = 1', (err, row) => {
                    getCbCount++;
                    throw new Error('Get Callback Exception');
                });
            },
            /Get Callback Exception/
        );
        assert.equal(getCbCount, 1);

        // 3. all 成功，callback 內部拋出例外
        let allCbCount = 0;
        await assert.rejects(
            async () => {
                await db.all('SELECT * FROM cb_test', (err, rows) => {
                    allCbCount++;
                    throw new Error('All Callback Exception');
                });
            },
            /All Callback Exception/
        );
        assert.equal(allCbCount, 1);

        // 4. run 失敗，callback 內部拋出例外
        let errCbCount = 0;
        await assert.rejects(
            async () => {
                await db.run('INSERT INTO cb_test VALUES (1, "duplicate")', (err) => {
                    errCbCount++;
                    assert.ok(err);
                    throw new Error('Err Callback Exception');
                });
            },
            /Err Callback Exception/
        );
        assert.equal(errCbCount, 1);

        // 🌟 5. PAUSED_DISK_FULL 入列拒絕回呼拋出例外 (P1-1)
        db.writeQueue.state = QUEUE_STATES.PAUSED_DISK_FULL;
        let dfRejectedCalled = 0;
        assert.doesNotThrow(() => {
            const accepted = db.queueDbOp('INSERT INTO cb_test VALUES (99, "df")', [], (err) => {
                dfRejectedCalled++;
                assert.ok(err);
                throw new Error('User Callback Crash on Disk Full');
            });
            assert.equal(accepted, false);
        });
        assert.equal(dfRejectedCalled, 1);
        db.writeQueue.resumeDiskFull();

        // 🌟 6. PAUSED_ERROR 入列拒絕回呼拋出例外 (P1-1)
        db.writeQueue.state = QUEUE_STATES.PAUSED_ERROR;
        let errRejectedCalled = 0;
        assert.doesNotThrow(() => {
            const accepted = db.queueDbOp('INSERT INTO cb_test VALUES (99, "pe")', [], (err) => {
                errRejectedCalled++;
                assert.ok(err);
                throw new Error('User Callback Crash on Paused Error');
            });
            assert.equal(accepted, false);
        });
        assert.equal(errRejectedCalled, 1);
        db.writeQueue.state = QUEUE_STATES.NORMAL;

        // 🌟 7. CLOSING 入列拒絕回呼拋出例外 (P1-1)
        db.writeQueue.state = QUEUE_STATES.CLOSING;
        let closingRejectedCalled = 0;
        assert.doesNotThrow(() => {
            const accepted = db.queueDbOp('INSERT INTO cb_test VALUES (99, "cl")', [], (err) => {
                closingRejectedCalled++;
                assert.ok(err);
                throw new Error('User Callback Crash on Closing');
            });
            assert.equal(accepted, false);
        });
        assert.equal(closingRejectedCalled, 1);
        db.writeQueue.state = QUEUE_STATES.NORMAL;

        // 🌟 8. BACKPRESSURE 入列拒絕回呼拋出例外 (P1-1)
        for (let i = 0; i < 5000; i++) {
            db.writeQueue.queue.push({ id: `bp_${i}`, seq: i, status: ITEM_STATUS.QUEUED });
        }
        let bpRejectedCalled = 0;
        assert.doesNotThrow(() => {
            const accepted = db.queueDbOp('INSERT INTO cb_test VALUES (99, "bp")', [], (err) => {
                bpRejectedCalled++;
                assert.ok(err);
                throw new Error('User Callback Crash on Backpressure');
            });
            assert.equal(accepted, false);
        });
        assert.equal(bpRejectedCalled, 1);
        db.writeQueue.queue = [];

        await db.close();
        cleanupTempDb(dbPath);
    });

    it('37. Database Factory 初始化與啟動前置保護 (v2.7.3 P1-4 / v2.7.4 整合防禦)', async () => {
        // 1. 正常非同步工廠建立
        const dbPath = getTempDbPath('factory_success');
        const db = await createDatabaseSubsystem({ dbPath });
        assert.equal(db.adapter.state, ADAPTER_STATES.READY);
        await db.close();
        cleanupTempDb(dbPath);

        // 2. 初始化失敗時，createDatabaseSubsystem 必須拒絕回傳
        await assert.rejects(
            async () => {
                await createDatabaseSubsystem({
                    dbPath: getTempDbPath('factory_fail'),
                    config: {
                        pragmas: { busy_timeout: -999 } // 無效 timeout 觸發 HARD_FAIL
                    }
                });
            },
            /HARD_FAIL/
        );

        // 3. initDatabaseSubsystemSync 提供 readyPromise 供主程式 await，失敗時拒絕
        const syncDb = initDatabaseSubsystemSync({
            dbPath: getTempDbPath('factory_sync_fail'),
            config: {
                pragmas: { busy_timeout: -999 }
            }
        });
        assert.ok(syncDb.readyPromise);
        await assert.rejects(
            async () => {
                await syncDb.readyPromise;
            },
            /HARD_FAIL/
        );
        assert.equal(syncDb.adapter.state, ADAPTER_STATES.ERROR);

        // 嘗試在 ERROR 狀態下執行操作，必須即刻拒絕
        await assert.rejects(
            async () => {
                await syncDb.run('SELECT 1');
            },
            /故障熔斷狀態/
        );

        // 🌟 4. 主程式啟動防禦整合驗證 (Mock Server 與 MQTT 啟動攔截)
        let serverListenCalled = false;
        let mqttClientStarted = false;

        async function mockStartServer(dbInstance) {
            try {
                if (dbInstance && dbInstance.readyPromise) {
                    await dbInstance.readyPromise;
                }
                serverListenCalled = true;
            } catch (_) {
                // 模擬捕獲初始化失敗，終止啟動
            }
        }

        async function mockStartMqtt(dbInstance) {
            try {
                if (dbInstance && dbInstance.readyPromise) {
                    await dbInstance.readyPromise;
                }
                mqttClientStarted = true;
            } catch (_) {
                // 模擬捕獲初始化失敗，取消 MQTT 連線
            }
        }

        await mockStartServer(syncDb);
        await mockStartMqtt(syncDb);

        assert.equal(serverListenCalled, false, '初始化失敗時絕對不得啟動 HTTP Server');
        assert.equal(mqttClientStarted, false, '初始化失敗時絕對不得啟動 MQTT Client');
    });

    // ==========================================
    // Group G: SQLite Reliability v2.7.4 Comprehensive Verifications (4 Scenarios)
    // ==========================================

    it('38. Drain 階段嚴格遵守 BUSY Retry Backoff 與守恆 (v2.7.4 P0-1)', async () => {
        const dbPath = getTempDbPath('drain_busy_backoff');
        const adapter = new SQLiteAdapter();
        const authority = adapter.bindShutdownHandler();
        const writeQueue = new WriteQueue(adapter, {
            retryBaseDelayMs: 80,
            retryMaxDelayMs: 200
        });
        await adapter.initialize(dbPath);
        await adapter.execute('CREATE TABLE busy_test (id INT PRIMARY KEY)');

        let attempts = 0;
        let firstFailureTime = null;
        let secondExecutionTime = null;
        const origDrainTx = adapter.drainTransaction.bind(adapter);

        adapter.drainTransaction = async function(fn, cap) {
            attempts++;
            if (attempts === 1) {
                firstFailureTime = Date.now();
                const busyErr = new Error('SQLITE_BUSY: database is locked');
                busyErr.code = 'SQLITE_BUSY';
                throw busyErr;
            }
            secondExecutionTime = Date.now();
            return origDrainTx(fn, cap);
        };

        writeQueue.enqueue('INSERT INTO busy_test VALUES (1)');
        assert.equal(writeQueue.queue.length, 1);

        const drainCap = authority.issueDrainCapability(1500);
        const drainResult = await writeQueue.drain(drainCap, 1500);

        assert.equal(attempts, 2, '應恰好執行 2 次交易 (第 1 次 BUSY, 第 2 次成功)');
        assert.ok(firstFailureTime && secondExecutionTime);
        const actualDelay = secondExecutionTime - firstFailureTime;
        assert.ok(actualDelay >= 75, `Drain 必須等待至少 80ms backoff，實際等待: ${actualDelay}ms`);

        assert.equal(drainResult.isClean, true);
        assert.equal(drainResult.uncommitted, 0);

        const row = await adapter.queryOne('SELECT id FROM busy_test WHERE id = 1');
        assert.ok(row);
        assert.equal(row.id, 1);

        // 驗證 Data Conservation: totalAccepted (1) === totalCommitted (1)
        assertDataConservation(writeQueue.getMetrics());

        adapter.drainTransaction = origDrainTx;
        await adapter.close();
        cleanupTempDb(dbPath);
    });

    it('39. Graceful Shutdown 有界等待與未靜止時拒絕 rawClose (v2.7.4 P0-2)', async () => {
        const dbPath = getTempDbPath('graceful_bounded_close');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: {
                shutdown: {
                    pm2KillTimeoutMs: 300,
                    drainWaitBufferMs: 100,
                    drainTimeoutMs: 150
                }
            }
        });

        // 排入一個尚未完成的 Deferred scheduler 任務
        let releaseHangingTask;
        const hangingDeferred = new Promise(r => releaseHangingTask = r);
        const runningTask = db.adapter._schedule(async () => {
            await hangingDeferred;
        });

        while (!db.adapter.isExecutingUnderlying) {
            await new Promise(r => setTimeout(r, 5));
        }

        // 驗證直接呼叫 adapter.close(100) 在逾時未靜止時被拒絕且不摧毀連線
        await assert.rejects(
            async () => {
                await db.adapter.close(80);
            },
            /CLOSE_REJECTED/
        );
        assert.equal(db.adapter.state, ADAPTER_STATES.CLOSING);
        assert.ok(db.adapter.db !== null, '未靜止時絕對不得執行 rawClose 摧毀連線');

        // 觸發 Graceful Shutdown
        const shutResult = await db.shutdownHandler.handle('TEST_SIG', { exitProcess: false });

        assert.equal(shutResult.success, false, '有未完成任務時 Shutdown 不得宣稱成功');
        assert.equal(shutResult.adapterClosed, false, '未靜止時 Adapter 不得標記關閉');
        assert.ok(shutResult.diagnostics);
        assert.equal(shutResult.diagnostics.adapterStatus.underlyingExecuting, true);

        // 釋放 deferred 任務並完成安全關閉
        releaseHangingTask();
        await runningTask;
        await db.adapter.emergencyClose(1000);
        cleanupTempDb(dbPath);
    });

    it('40. Emergency Shutdown 檢查未提交資料與誠實成功語意 (v2.7.4 P0-3)', async () => {
        const dbPath = getTempDbPath('emergency_uncommitted_audit');
        const db = await createDatabaseSubsystem({ dbPath });
        await db.run('CREATE TABLE emerg_test (id INT)');

        // 接受 20 筆資料進入佇列（未啟動交易提交）
        for (let i = 0; i < 20; i++) {
            db.queueDbOp('INSERT INTO emerg_test VALUES (?)', [i]);
        }
        assert.equal(db.writeQueue.queue.length, 20);
        assert.equal(db.writeQueue.getMetrics().totalUncommitted, 20);

        // 確認此時 Adapter 處於 Quiescent 靜止狀態
        assert.equal(db.adapter.isQuiescent(), true);

        // 觸發緊急關閉
        const crashResult = await db.shutdownHandler.handleEmergencyCrash(
            new Error('Crash with 20 queued items'),
            'testUncaught',
            { exitProcess: false }
        );

        // 🌟 P0-3 核心驗證：即使 Adapter 成功 emergencyClose，但有未提交資料時，success 必須為 false！
        assert.equal(crashResult.success, false, '有 20 筆未提交資料時絕對不得回報整體 success: true');
        assert.equal(crashResult.adapterClosed, true, 'Adapter 靜止狀態下連線成功釋放');
        assert.equal(crashResult.dataClean, false, '資料存在未提交，dataClean 必須為 false');
        assert.equal(crashResult.hasUncommittedData, true);
        assert.equal(crashResult.forcedExit, false);
        assert.ok(crashResult.diagnostics);
        assert.equal(crashResult.diagnostics.queueMetrics.queuedCount, 20);
        assert.equal(crashResult.diagnostics.queueMetrics.totalUncommitted, 20);

        cleanupTempDb(dbPath);
    });

    it('41. 初始化失敗時安全清理 SQLite 連線防洩漏 (v2.7.4 P1-2)', async () => {
        const dbPath = getTempDbPath('init_cleanup_leak');
        const badAdapter = new SQLiteAdapter({
            pragmas: {
                busy_timeout: -999 // 觸發 HARD_FAIL 驗證失敗
            }
        });

        await assert.rejects(
            async () => {
                await badAdapter.initialize(dbPath);
            },
            /HARD_FAIL.*busy_timeout/
        );

        // 驗證 Adapter 狀態為 ERROR
        assert.equal(badAdapter.state, ADAPTER_STATES.ERROR);
        // 🌟 P1-2 核心驗證：已開啟之 SQLite 原生 handle 已被妥善關閉並清空，絕不遺留洩漏
        assert.equal(badAdapter.db, null, '初始化失敗後連線 handle 必須被安全關閉並清空');

        cleanupTempDb(dbPath);
    });

    // ==========================================
    // Group H: SQLite Reliability v2.7.5 Final Hardening & Verification (3 Scenarios)
    // ==========================================

    it('42. Checkpoint Task Execution Delay Simulation 與 Shutdown 共用 Deadline (v2.7.5 P0 / v2.7.6 修正)', async () => {
        const dbPath = getTempDbPath('checkpoint_shared_deadline');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: {
                shutdown: {
                    pm2KillTimeoutMs: 220,
                    drainTimeoutMs: 120,
                    drainWaitBufferMs: 80
                }
            }
        });
        await db.run('CREATE TABLE cp_deadline_test (id INT PRIMARY KEY)');

        // 1. 排入 2 筆待排空資料，確保 Drain 正常完成
        db.queueDbOp('INSERT INTO cp_deadline_test VALUES (1)');
        db.queueDbOp('INSERT INTO cp_deadline_test VALUES (2)');

        // 2. 攔截 Adapter 內部 _rawQueryOne，以 Deferred 模擬 Checkpoint Task 在 Adapter 執行層等待超過共用 Deadline
        //    (註：此為 Checkpoint Task Execution Delay Simulation，驗證 Adapter/ShutdownHandler 共用 Deadline 與狀態保護，非 C++ native thread 阻塞)
        let releaseCheckpoint;
        const checkpointDeferred = new Promise((resolve) => { releaseCheckpoint = resolve; });
        let checkpointStarted = false;
        let rawCloseCalled = false;

        const origRawQueryOne = db.adapter._rawQueryOne.bind(db.adapter);
        db.adapter._rawQueryOne = async function(sql, params) {
            if (String(sql).includes('wal_checkpoint(TRUNCATE)')) {
                checkpointStarted = true;
                await checkpointDeferred;
            }
            return origRawQueryOne(sql, params);
        };

        const origRawClose = db.adapter._rawClose.bind(db.adapter);
        db.adapter._rawClose = async function() {
            rawCloseCalled = true;
            return origRawClose();
        };

        // 3. 觸發 Graceful Shutdown，驗證共用單一 Deadline
        const startT = Date.now();
        const shutResult = await db.shutdownHandler.handle('SIGTERM', { exitProcess: false });
        const elapsed = Date.now() - startT;

        // 4. 驗證 Shutdown 在總時間預算 (220ms，容許合理計時器誤差 200ms~255ms) 內返回，未在 Close 階段額外保底等待 100ms
        assert.equal(checkpointStarted, true, 'Drain 正常完成後應進入 TRUNCATE Checkpoint');
        assert.ok(elapsed >= 200 && elapsed <= 255, `Shutdown 必須受單一共用 Deadline (220ms) 約束準時返回 (200~255ms)，實際耗時: ${elapsed}ms`);

        // 5. 驗證結果明確標記 Checkpoint Timeout，且不得誤判為成功
        assert.equal(shutResult.success, false, 'Checkpoint 超時時 Shutdown 絕對不得回報成功');
        assert.equal(shutResult.checkpointTimedOut, true, '必須明確標記 checkpointTimedOut: true');
        assert.equal(shutResult.checkpointCompleted, false, '不得誤判為 Checkpoint 完成');
        assert.equal(shutResult.deadlineExpired, true, '必須標記共用 Deadline 已到期');
        assert.equal(shutResult.dataClean, true, 'Drain 階段本身已完成 2 筆資料提交');

        // 6. 驗證不得對仍在執行 Checkpoint 的底層連線呼叫 rawClose
        assert.equal(shutResult.adapterClosed, false, 'Checkpoint 仍在底層執行時 Adapter 不得關閉');
        assert.equal(rawCloseCalled, false, '仍在執行底層操作時嚴禁呼叫 _rawClose()');
        assert.ok(db.adapter.db !== null, '底層連線實例必須保留，避免 native crash');

        // 7. 驗證 Diagnostics 完整保留 Checkpoint 與 Adapter 執行狀態
        assert.ok(shutResult.diagnostics);
        assert.ok(shutResult.diagnostics.checkpoint);
        assert.equal(shutResult.diagnostics.checkpoint.attempted, true);
        assert.equal(shutResult.diagnostics.checkpoint.completed, false);
        assert.equal(shutResult.diagnostics.checkpoint.timedOut, true);
        assert.match(shutResult.diagnostics.checkpoint.error, /CHECKPOINT_TIMEOUT/);
        assert.equal(shutResult.diagnostics.adapterStatus.checkpointInProgress, true);
        assert.equal(shutResult.diagnostics.adapterStatus.underlyingExecuting, true);
        assert.equal(shutResult.diagnostics.adapterStatus.schedulerActive, 1);
        assert.equal(shutResult.diagnostics.adapterStatus.isQuiescent, false);

        // 8. 釋放 Deferred Checkpoint 任務並安全清理資源
        releaseCheckpoint();
        while (!db.adapter.isQuiescent()) {
            await new Promise(r => setTimeout(r, 5));
        }
        db.adapter._rawQueryOne = origRawQueryOne;
        db.adapter._rawClose = origRawClose;
        await db.adapter.emergencyClose(1000);
        cleanupTempDb(dbPath);
    });

    it('43. Emergency Shutdown Queue In-Flight Race 防護驗證 (v2.7.5 P1)', async () => {
        const dbPath = getTempDbPath('emergency_inflight_race');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: {
                shutdown: {
                    emergencyWaitMs: 60
                }
            }
        });
        await db.run('CREATE TABLE race_test (id INT PRIMARY KEY)');

        // 1. 攔截 adapter.transaction，在 Flush Worker 已將項目移入 IN_FLIGHT 但 Adapter 尚未註冊 Scheduler 前建立真實競態窗口
        let releasePreScheduleBarrier;
        const preScheduleBarrier = new Promise((resolve) => { releasePreScheduleBarrier = resolve; });
        let NotifyEnteredInFlightWindow;
        const enteredInFlightWindow = new Promise((resolve) => { NotifyEnteredInFlightWindow = resolve; });

        const origTransaction = db.adapter.transaction.bind(db.adapter);
        db.adapter.transaction = async function(workFn) {
            // 此時 WriteQueue.flush() 已將項目轉為 IN_FLIGHT 且 isFlushing = true，但尚未進入 adapter._schedule()
            NotifyEnteredInFlightWindow();
            await preScheduleBarrier;
            return origTransaction(workFn);
        };

        let emergencyCloseCalled = false;
        const origEmergencyClose = db.adapter.emergencyClose.bind(db.adapter);
        db.adapter.emergencyClose = async function(...args) {
            emergencyCloseCalled = true;
            return origEmergencyClose(...args);
        };

        // 2. 入列 1 筆資料並啟動真實 Flush Worker 控制流程
        const accepted = db.queueDbOp('INSERT INTO race_test VALUES (1)');
        assert.equal(accepted, true);
        const flushPromise = db.writeQueue.flush();

        // 3. 等待進入「Item 已 IN_FLIGHT、Flush Worker 執行中，但 Adapter 尚未註冊 Scheduler」之真實競態點
        await enteredInFlightWindow;

        assert.equal(db.writeQueue.inFlightCount, 1, '項目必須已進入 IN_FLIGHT 狀態');
        assert.equal(db.writeQueue.isFlushWorkerActive(), true, 'Flush Worker 必須處於活動狀態');
        assert.equal(db.adapter.isQuiescent(), true, '此時 Adapter 尚未註冊排程，暫時回報 Quiescent');

        // 4. 在此競態窗口觸發 Emergency Shutdown
        const crashResult = await db.shutdownHandler.handleEmergencyCrash(
            new Error('Race Condition Crash'),
            'uncaughtException',
            { exitProcess: false }
        );

        // 5. 驗證即使 Adapter 暫時 Quiescent，Emergency Shutdown 仍因 In-Flight 與 Flush Worker 活動而拒絕呼叫 emergencyClose
        assert.equal(emergencyCloseCalled, false, 'Queue 有 In-Flight 或 Flush Worker 活動時嚴禁呼叫 emergencyClose');
        assert.equal(crashResult.success, false);
        assert.equal(crashResult.adapterClosed, false);
        assert.equal(crashResult.dataClean, false);
        assert.equal(crashResult.hasUncommittedData, true);
        assert.equal(crashResult.forcedExit, true);
        assert.ok(db.adapter.db !== null, '底層資料庫連線不得被關閉');

        // 6. 驗證 Diagnostics 正確反映 Flush Worker 與 In-Flight 狀態，且資料無遺失
        assert.equal(crashResult.flushWorkerActive, true);
        assert.equal(crashResult.queueMetrics.inFlightCount, 1);
        assert.equal(crashResult.queueMetrics.totalUncommitted, 1);
        assert.ok(crashResult.diagnostics);
        assert.equal(crashResult.diagnostics.flushWorkerActive, true);
        assert.equal(crashResult.diagnostics.queueMetrics.inFlightCount, 1);
        assert.equal(crashResult.diagnostics.adapterStatus.isQuiescent, true);
        assertDataConservation(db.writeQueue.getMetrics());

        // 7. 釋放競態屏障，等待 Flush Worker 收斂並驗證項目未遺失 (轉入 uncommittedErrors 保全)
        releasePreScheduleBarrier();
        await flushPromise;

        const finalMetrics = db.writeQueue.getMetrics();
        assertDataConservation(finalMetrics);
        assert.equal(finalMetrics.totalAccepted, 1);
        assert.equal(finalMetrics.totalUncommitted, 1);
        assert.equal(finalMetrics.uncommittedErrorCount, 1);

        // 8. 恢復方法並完成最終清理
        db.adapter.transaction = origTransaction;
        db.adapter.emergencyClose = origEmergencyClose;
        await db.adapter.emergencyClose(1000);
        cleanupTempDb(dbPath);
    });

    it('44. Initialization Failure Native Close Completion 與錯誤隔離驗證 (v2.7.5 P1)', async () => {
        const dbPath = getTempDbPath('init_native_close_await');

        let releaseCloseCallback;
        const closeDeferred = new Promise((resolve) => { releaseCloseCallback = resolve; });
        let notifyCloseInvoked;
        const closeInvokedPromise = new Promise((resolve) => { notifyCloseInvoked = resolve; });
        let closeCallbackCompleted = false;

        // 使用包裝後之真實 sqlite3.Database，保留真實非同步 close 並以 Deferred 控制 callback 完成時機
        const badAdapter = new SQLiteAdapter({
            pragmas: {
                busy_timeout: -999 // 觸發 PRAGMA 驗證 HARD_FAIL
            },
            databaseFactory: (targetPath, openCb) => {
                const realDb = new sqlite3.Database(targetPath, openCb);
                const origClose = realDb.close.bind(realDb);
                realDb.close = (closeCb) => {
                    notifyCloseInvoked();
                    // 先執行真實原生 close 釋放檔案控制代碼，再由 Deferred 控制回呼完成時點與模擬 Cleanup Error
                    origClose(async () => {
                        await closeDeferred;
                        closeCallbackCompleted = true;
                        if (typeof closeCb === 'function') {
                            closeCb(new Error('Simulated native close cleanup error'));
                        }
                    });
                };
                return realDb;
            }
        });

        // 1. 啟動初始化，追蹤 Promise 是否已 settle
        let initSettled = false;
        let caughtInitErr = null;
        const initPromise = badAdapter.initialize(dbPath).then(
            () => { initSettled = true; },
            (err) => {
                initSettled = true;
                caughtInitErr = err;
                throw err;
            }
        );

        // 2. 等待 PRAGMA 驗證失敗並進入 db.close()
        await closeInvokedPromise;

        // 3. 在 Deferred close callback 尚未釋放前，驗證公開連線 reference 已清空，且 initialize Promise 尚未 reject！
        assert.equal(badAdapter.db, null, '進入清理時公開 this.db 必須立即設為 null 防止外部誤用');
        await new Promise(r => setTimeout(r, 30));
        assert.equal(closeCallbackCompleted, false, 'Deferred 釋放前 close callback 尚未完成');
        assert.equal(initSettled, false, '在原生 close callback 完成前，initialize Promise 絕對不得提前 reject');

        // 4. 釋放 Deferred close callback，驗證 initialize Promise 此時才 reject 原始錯誤
        releaseCloseCallback();

        await assert.rejects(
            async () => {
                await initPromise;
            },
            /HARD_FAIL.*busy_timeout/
        );

        // 5. 驗證所有最終狀態與錯誤隔離要求
        assert.equal(initSettled, true);
        assert.equal(closeCallbackCompleted, true, '原生 close callback 必須確實完成');
        assert.equal(badAdapter.state, ADAPTER_STATES.ERROR, 'Adapter 最終狀態必須為 ERROR');
        assert.equal(badAdapter.db, null, 'Adapter 連線 reference 必須保持為 null');
        assert.ok(caughtInitErr);
        assert.match(caughtInitErr.message, /HARD_FAIL.*busy_timeout/, '必須 reject 原始 Initialization Error');
        assert.match(badAdapter.lastError.message, /HARD_FAIL.*busy_timeout/, 'lastError 不得被 Cleanup Error 覆蓋');
        assert.ok(badAdapter.lastCleanupError, 'Cleanup Error 必須被獨立記錄');
        assert.match(badAdapter.lastCleanupError.message, /Simulated native close cleanup error/);

        cleanupTempDb(dbPath);
    });

    // ==========================================
    // Group I: SQLite Reliability v2.7.6 / v2.7.7 Native Close Deadline Hardening & Final Closure (2 Scenarios)
    // ==========================================

    it('45. Native Close Callback Deadline — Native Close Callback Delay Simulation (v2.7.6 P0-1 & P0-3)', async () => {
        const dbPath = getTempDbPath('graceful_native_close_deadline');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: {
                shutdown: {
                    pm2KillTimeoutMs: 220,
                    drainTimeoutMs: 120,
                    drainWaitBufferMs: 80
                }
            }
        });
        await db.run('CREATE TABLE close_deadline_test (id INT PRIMARY KEY)');

        // 1. 排入 2 筆資料，確保 Graceful Shutdown 的 Drain 與 TRUNCATE Checkpoint 正常完成並進入 Close 階段
        db.queueDbOp('INSERT INTO close_deadline_test VALUES (1)');
        db.queueDbOp('INSERT INTO close_deadline_test VALUES (2)');

        // 2. Native Close Callback Delay Simulation:
        //    攔截底層 db.close(callback)，以 Deferred 延遲 JS close callback 完成時點
        let releaseNativeCloseCallback;
        const nativeCloseDeferred = new Promise((resolve) => { releaseNativeCloseCallback = resolve; });
        let closeCallCount = 0;
        let savedCloseCallback = null;
        const realUnderlyingDb = db.adapter.db;
        const origDbClose = realUnderlyingDb.close.bind(realUnderlyingDb);

        realUnderlyingDb.close = (cb) => {
            closeCallCount++;
            savedCloseCallback = cb;
            // 先執行底層真實 close 釋放 OS 檔案鎖，再透過 Deferred 控制 callback 回傳給 Adapter 的時間點
            origDbClose(async (err) => {
                await nativeCloseDeferred;
                if (typeof cb === 'function') {
                    cb(err);
                }
            });
        };

        // 3. 觸發 Graceful Shutdown，驗證等待時間受單一共用 Deadline (220ms) 約束
        const startT = Date.now();
        const shutResult = await db.shutdownHandler.handle('SIGTERM', { exitProcess: false });
        const elapsed = Date.now() - startT;

        assert.equal(closeCallCount, 1, 'db.close(callback) 必須已被呼叫且僅呼叫一次');
        assert.ok(elapsed >= 200 && elapsed <= 255, `Graceful Shutdown 等待 native close 必須受單一 Deadline (220ms) 約束 (200~255ms)，實際耗時: ${elapsed}ms`);

        // 4. 驗證超時當下嚴格區分 closeTimedOut / nativeClosePending / adapterClosed
        assert.equal(shutResult.success, false, 'Native close 超時未完成時 Shutdown 絕對不得回報成功');
        assert.equal(shutResult.checkpointCompleted, true, '進入 Close 前 Drain 與 Checkpoint 已完成');
        assert.equal(shutResult.adapterClosed, false, 'closeTimedOut 不代表 adapterClosed，必須為 false');
        assert.equal(shutResult.nativeClosePending, true, '必須明確標記 nativeClosePending: true');
        assert.equal(shutResult.closeTimedOut, true, '必須明確標記 closeTimedOut: true');
        assert.equal(shutResult.deadlineExpired, true, '必須標記共用 Deadline 已到期');
        assert.ok(shutResult.diagnostics);
        assert.equal(shutResult.diagnostics.nativeClosePending, true);
        assert.equal(shutResult.diagnostics.closeTimedOut, true);
        assert.equal(shutResult.diagnostics.adapterClosed, false);
        assert.match(shutResult.diagnostics.closeError, /NATIVE_CLOSE_TIMEOUT/);

        const statusDuringPending = db.adapter.getActiveStatus();
        assert.equal(db.adapter.state, ADAPTER_STATES.CLOSING, 'Callback 返回前 Adapter 必須維持 CLOSING 狀態');
        assert.equal(statusDuringPending.nativeClosePending, true);
        assert.equal(statusDuringPending.closeTimedOut, true);
        assert.equal(statusDuringPending.adapterClosed, false);
        assert.equal(statusDuringPending.isQuiescent, false, 'nativeClosePending 期間 Adapter 不得回報 Quiescent');

        // 5. 驗證不得提前將 db handle 設為 null，且嚴格拒絕任何新資料庫操作
        assert.ok(db.adapter.db !== null, 'Native close callback 完成前不得提前清除 db handle');
        await assert.rejects(
            async () => { await db.adapter.execute('INSERT INTO close_deadline_test VALUES (3)'); },
            /ADAPTER_CLOSING_NATIVE_PENDING|GATE_CLOSED|ADAPTER_CLOSING/
        );
        await assert.rejects(
            async () => { await db.adapter.query('SELECT * FROM close_deadline_test'); },
            /ADAPTER_CLOSING_NATIVE_PENDING|GATE_CLOSED|ADAPTER_CLOSING/
        );
        await assert.rejects(
            async () => { await db.adapter.transaction(async () => {}); },
            /ADAPTER_CLOSING_NATIVE_PENDING|GATE_CLOSED|ADAPTER_CLOSING/
        );
        await assert.rejects(
            async () => { await db.adapter._rawQueryOne('SELECT 1'); },
            /DB_CLOSING_NATIVE_PENDING/
        );

        // 6. Case A & Case D 驗證：Close Timeout 後再次呼叫 close() 或 emergencyClose() 絕對不得重複呼叫底層 db.close()
        await assert.rejects(
            async () => { await db.adapter.close(25); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        await assert.rejects(
            async () => { await db.adapter.emergencyClose(null, 25); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        assert.equal(closeCallCount, 1, '重複呼叫 close() 或 emergencyClose() 絕對不得第二次呼叫原生 db.close()');

        // 7. Case B 驗證：釋放 Deferred close callback，驗證 Adapter 正確轉移為 CLOSED 且不重複結算
        const waitFinalClose = db.adapter.close(500);
        releaseNativeCloseCallback();
        await waitFinalClose;

        // 測試若無良 callback 被重複觸發也不會破壞狀態或重複結算
        if (typeof savedCloseCallback === 'function') {
            savedCloseCallback(new Error('Duplicate callback invocation should be ignored'));
        }

        const finalStatus = db.adapter.getActiveStatus();
        assert.equal(closeCallCount, 1, '全流程原生 db.close() 呼叫次數必須嚴格為 1');
        assert.equal(db.adapter.state, ADAPTER_STATES.CLOSED, 'Callback 成功返回後才可標記為 CLOSED');
        assert.equal(db.adapter.db, null, 'Callback 成功返回後才清空 db handle');
        assert.equal(finalStatus.nativeClosePending, false);
        assert.equal(finalStatus.closeTimedOut, false);
        assert.equal(finalStatus.adapterClosed, true);

        cleanupTempDb(dbPath);
    });

    it('46. Emergency Native Close Callback Deadline 與 Delayed Native Close Callback Error Handling — Callback Error Injection Simulation (v2.7.6 P0-2 / v2.7.7 P1 & P2)', async () => {
        // --- Part A: Emergency Close Deadline 強制要求與 Native Close Callback Delay Simulation ---
        const dbPath = getTempDbPath('emergency_native_close_deadline');
        const db = await createDatabaseSubsystem({
            dbPath,
            config: {
                shutdown: {
                    emergencyWaitMs: 120
                }
            }
        });
        await db.run('CREATE TABLE emerg_close_deadline (id INT PRIMARY KEY)');

        let releaseEmergencyCloseCb;
        const emergencyCloseDeferred = new Promise((resolve) => { releaseEmergencyCloseCb = resolve; });
        let closeCallCount = 0;
        const realUnderlyingDb = db.adapter.db;
        const origDbClose = realUnderlyingDb.close.bind(realUnderlyingDb);

        realUnderlyingDb.close = (cb) => {
            closeCallCount++;
            origDbClose(async (err) => {
                await emergencyCloseDeferred;
                if (typeof cb === 'function') {
                    cb(err);
                }
            });
        };

        // 0-A. v2.7.7 P1 驗證：不提供 Deadline (無 timeoutMs 且無 deadlineAt) 時，emergencyClose() 必須明確拒絕且不呼叫 db.close()
        await assert.rejects(
            async () => { await db.adapter.emergencyClose(); },
            /EMERGENCY_CLOSE_DEADLINE_REQUIRED/
        );
        await assert.rejects(
            async () => { await db.adapter.emergencyClose({ inFlightCount: 0, flushWorkerActive: false }); },
            /EMERGENCY_CLOSE_DEADLINE_REQUIRED/
        );
        assert.equal(closeCallCount, 0, '缺少 Deadline 拒絕時不得呼叫底層 db.close()');
        assert.equal(db.adapter.state, ADAPTER_STATES.READY, '缺少 Deadline 被拒時 Adapter 維持 READY 狀態');

        // 0-B. v2.7.7 P1 驗證：傳入已過期之 deadlineAt 時，不得無限等待且不得啟動底層 db.close()
        const expiredStart = Date.now();
        await assert.rejects(
            async () => { await db.adapter.emergencyClose({ deadlineAt: Date.now() - 50 }); },
            /CLOSE_TIMEOUT/
        );
        const expiredElapsed = Date.now() - expiredStart;
        assert.ok(expiredElapsed < 25, `已過期 Deadline 必須立即失敗返回 (<25ms)，實際耗時: ${expiredElapsed}ms`);
        assert.equal(closeCallCount, 0, '進入前 Deadline 已過期不得啟動底層 db.close()');

        // 1. 觸發 handleEmergencyCrash，驗證受共用 emergencyWaitMs (120ms) 約束，不會無限等待
        const startT = Date.now();
        const crashResult = await db.shutdownHandler.handleEmergencyCrash(
            new Error('Simulated Fatal Exception'),
            'uncaughtException',
            { exitProcess: false }
        );
        const elapsed = Date.now() - startT;

        assert.equal(closeCallCount, 1, 'Emergency Close 必須呼叫且僅呼叫一次原生 db.close()');
        assert.ok(elapsed >= 100 && elapsed <= 165, `handleEmergencyCrash 必須受 emergencyWaitMs (120ms) 約束準時返回 (100~165ms)，實際耗時: ${elapsed}ms`);

        // 2. 驗證超時後狀態誠實回報：adapterClosed 為 false、nativeClosePending 為 true、closeTimedOut 為 true
        assert.equal(crashResult.success, false, 'Native close 超時未返回時 Emergency Shutdown 不得宣稱成功');
        assert.equal(crashResult.adapterClosed, false, 'Callback 未返回前 adapterClosed 必須維持 false');
        assert.equal(crashResult.nativeClosePending, true, '必須回報 nativeClosePending: true');
        assert.equal(crashResult.closeTimedOut, true, '必須回報 closeTimedOut: true');
        assert.equal(crashResult.forcedExit, false);

        // 3. 驗證 Diagnostics 完整保留 native close pending 與 timeout 診斷資訊
        assert.ok(crashResult.diagnostics);
        assert.equal(crashResult.diagnostics.nativeClosePending, true);
        assert.equal(crashResult.diagnostics.closeTimedOut, true);
        assert.equal(crashResult.diagnostics.adapterClosed, false);
        assert.match(crashResult.diagnostics.closeError, /NATIVE_CLOSE_TIMEOUT/);
        assert.equal(crashResult.diagnostics.adapterStatus.nativeClosePending, true);
        assert.equal(crashResult.diagnostics.adapterStatus.state, ADAPTER_STATES.CLOSING);

        // 4. 驗證已有 nativeClosePending 時：無 Deadline 拒絕、已過期 Deadline 立即返回、timeoutMs 轉換、指定 deadlineAt 皆重用 #nativeClosePromise 且不重複呼叫 db.close()
        assert.ok(db.adapter.db !== null, 'Native close pending 期間不得提前清空 db reference');
        await assert.rejects(
            async () => { await db.adapter.emergencyClose(); },
            /EMERGENCY_CLOSE_DEADLINE_REQUIRED/
        );
        const pendingExpiredStart = Date.now();
        await assert.rejects(
            async () => { await db.adapter.emergencyClose(null, { deadlineAt: Date.now() - 10 }); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        assert.ok(Date.now() - pendingExpiredStart < 25, '已有 nativeClosePending 且 Deadline 已過期時不得繼續等待');
        await assert.rejects(
            async () => { await db.adapter.emergencyClose(null, 20); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        await assert.rejects(
            async () => { await db.adapter.emergencyClose(null, { deadlineAt: Date.now() + 20 }); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        await assert.rejects(
            async () => { await db.adapter.close(20); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        assert.equal(closeCallCount, 1, '後續 emergencyClose/close 不得重複呼叫原生 db.close()');

        await assert.rejects(
            async () => { await db.adapter.execute('INSERT INTO emerg_close_deadline VALUES (1)'); },
            /ADAPTER_CLOSING_NATIVE_PENDING|GATE_CLOSED|ADAPTER_CLOSING/
        );
        await assert.rejects(
            async () => { await db.adapter._rawExecute('INSERT INTO emerg_close_deadline VALUES (1)'); },
            /DB_CLOSING_NATIVE_PENDING/
        );

        // 5. 當延遲的 native callback 最終成功返回時，提供有效 deadlineAt 驗證 Adapter 正確更新為 CLOSED
        const finalClosePromise = db.adapter.emergencyClose(null, { deadlineAt: Date.now() + 500 });
        releaseEmergencyCloseCb();
        await finalClosePromise;

        assert.equal(closeCallCount, 1);
        assert.equal(db.adapter.state, ADAPTER_STATES.CLOSED);
        assert.equal(db.adapter.db, null);
        assert.equal(db.adapter.getActiveStatus().nativeClosePending, false);
        assert.equal(db.adapter.getActiveStatus().adapterClosed, true);
        cleanupTempDb(dbPath);

        // --- Part B (Case C): Delayed Native Close Callback Error Handling (Callback Error Injection Simulation) ---
        // 註：此段先呼叫真實 origErrDbClose() 釋放底層檔案控制代碼，再透過 Deferred 延遲 callback 並注入模擬之 SQLITE_BUSY 錯誤，
        //     旨在驗證 Adapter 收到延遲的 close callback error 時之 ERROR 狀態轉移與錯誤保留邏輯 (Callback Error Injection Simulation)，
        //     而非在 SQLite C++ 引擎內部實際製造未 finalize statement 的原生 SQLITE_BUSY 鎖定。
        const errDbPath = getTempDbPath('emergency_native_close_error');
        const errDb = await createDatabaseSubsystem({ dbPath: errDbPath });
        await errDb.run('CREATE TABLE close_err_test (id INT)');

        let releaseErrCloseCb;
        const errCloseDeferred = new Promise((resolve) => { releaseErrCloseCb = resolve; });
        let errCloseCallCount = 0;
        const realErrDb = errDb.adapter.db;
        const origErrDbClose = realErrDb.close.bind(realErrDb);

        realErrDb.close = (cb) => {
            errCloseCallCount++;
            origErrDbClose(async () => {
                await errCloseDeferred;
                if (typeof cb === 'function') {
                    cb(new Error('Simulated callback error: SQLITE_BUSY: unable to close due to unfinalized statements'));
                }
            });
        };

        // 先以 timeoutMs=30 讓呼叫端等待超時
        await assert.rejects(
            async () => { await errDb.adapter.emergencyClose(null, 30); },
            /NATIVE_CLOSE_TIMEOUT/
        );
        assert.equal(errDb.adapter.state, ADAPTER_STATES.CLOSING);
        assert.equal(errDb.adapter.getActiveStatus().nativeClosePending, true);
        assert.equal(errDb.adapter.getActiveStatus().closeTimedOut, true);

        // 釋放 callback 並注入模擬錯誤
        releaseErrCloseCb();
        await assert.rejects(
            async () => { await errDb.adapter.close(); },
            /Simulated callback error: SQLITE_BUSY: unable to close/
        );

        const errStatus = errDb.adapter.getActiveStatus();
        assert.equal(errCloseCallCount, 1, '即使回傳錯誤亦不得重複呼叫 db.close()');
        assert.equal(errDb.adapter.state, ADAPTER_STATES.ERROR, 'Native close callback 回報失敗時必須進入 ERROR 狀態，不得標記為 CLOSED');
        assert.equal(errStatus.adapterClosed, false, 'Native close callback 回報失敗時 adapterClosed 必須為 false');
        assert.equal(errStatus.nativeClosePending, false, 'Callback 已返回，nativeClosePending 應更新為 false');
        assert.match(errStatus.lastCloseError, /Simulated callback error: SQLITE_BUSY: unable to close/, '必須保留 close callback 錯誤資訊');
        assert.match(errDb.adapter.lastError.message, /Simulated callback error: SQLITE_BUSY: unable to close/);
        await assert.rejects(
            async () => { await errDb.adapter.query('SELECT 1'); },
            /故障熔斷狀態|SQLITE_BUSY/
        );

        cleanupTempDb(errDbPath);
    });

});
