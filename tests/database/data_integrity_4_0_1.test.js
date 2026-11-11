// tests/database/data_integrity_4_0_1.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const {
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
    ADAPTER_STATES,
    BACKUP_VERIFY_STATUS
} = require('../../src/database');

function getTempDbPath(name = 'di401') {
    return path.join(
        os.tmpdir(),
        `meshtastic_401_${name}_${Date.now()}_${Math.random().toString(36).substring(7)}.db`
    );
}

function getTempDir(name = 'di401_dir') {
    const dir = path.join(
        os.tmpdir(),
        `meshtastic_401_${name}_${Date.now()}_${Math.random().toString(36).substring(7)}`
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanupTempDb(dbPath) {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch (_) {}
    try { if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`); } catch (_) {}
    try { if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`); } catch (_) {}
}

function cleanupTempDir(dirPath) {
    try {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
    } catch (_) {}
}

describe('Meshtastic-DashBoard 4.0.1 — Database Bootstrap & Backup Integrity Suite', () => {

    // =========================================================================
    // Part A: Database Bootstrap & Schema Initialization Barrier (Tests A - F)
    // =========================================================================

    it('Test A — Normal Initialization: 空的 Temporary DB 建立所有必要 Schema、Migration 與 Index 後進入 READY', async () => {
        const dbPath = getTempDbPath('test_a_normal_init');
        const backupDir = getTempDir('test_a_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            assert.equal(db.adapter.state, ADAPTER_STATES.READY);
            assert.equal(db.isSchemaReady, true);
            assert.equal(db.bootstrapError, null);
            assert.equal(db.isBootstrapReady(), true);
            assert.ok(db.schemaReport);
            assert.equal(db.schemaReport.tablesCreatedOrVerified.length, REQUIRED_TABLES.length);
            assert.equal(db.schemaReport.indexesCreatedOrVerified.length, REQUIRED_INDEXES.length);
            assert.equal(db.schemaReport.verification.verified, true);

            // 驗證新增欄位 (如 packet_logs 的 latitude, longitude, hops_away, source) 已由 Migration 建立
            const packetLogCols = await getTableColumns(db.adapter, 'packet_logs');
            const colNames = packetLogCols.map(c => c.name);
            for (const col of ['latitude', 'longitude', 'hops_away', 'source', 'gateway_id', 'hop_limit', 'hop_start']) {
                assert.ok(colNames.includes(col), `packet_logs 應包含欄位 ${col}`);
            }

            // 驗證資料庫可正常讀寫
            await db.run(
                `INSERT INTO nodes (node_id, long_name, short_name, is_favorite, role) VALUES (?, ?, ?, ?, ?)`,
                ['!11223344', 'TestNode-A', 'TNA', 1, 'ROUTER']
            );
            const nodeRow = await db.get(`SELECT * FROM nodes WHERE node_id = ?`, ['!11223344']);
            assert.equal(nodeRow.long_name, 'TestNode-A');
            assert.equal(nodeRow.role, 'ROUTER');

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test B — Repeated Initialization: 對同一個 Temporary DB 連續執行兩次初始化，不產生重複欄位錯誤且不破壞既有資料', async () => {
        const dbPath = getTempDbPath('test_b_repeated_init');
        const backupDir = getTempDir('test_b_backups');

        try {
            // 第一次初始化並寫入測試資料
            const db1 = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            await db1.run(
                `INSERT INTO nodes (node_id, long_name, short_name, battery_level, last_gateway) VALUES (?, ?, ?, ?, ?)`,
                ['!aabbccdd', 'RepeatNode', 'RPT', 95.5, '!gw01']
            );
            await db1.run(
                `INSERT INTO packet_logs (node_id, portnum, gateway_id, latitude, longitude, hops_away, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['!aabbccdd', 'POSITION_APP', '!gw01', 25.033, 121.565, 2, 'MQTT']
            );
            await db1.close();

            // 第二次對同一 DB 執行完整初始化與 Schema Bootstrap
            const db2 = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            assert.equal(db2.isBootstrapReady(), true);
            assert.equal(db2.schemaReport.columnsAdded.length, 0);
            assert.equal(db2.schemaReport.columnsAlreadyExisted.length, COLUMN_MIGRATIONS.length);
            assert.equal(db2.schemaReport.verification.verified, true);

            // 再於同一連線重複呼叫 bootstrapDatabaseSchema 驗證完全冪等
            const secondReport = await db2.bootstrapSchema();
            assert.equal(secondReport.columnsAdded.length, 0);
            assert.equal(secondReport.columnsAlreadyExisted.length, COLUMN_MIGRATIONS.length);

            // 確認既有資料毫髮無損
            const node = await db2.get(`SELECT * FROM nodes WHERE node_id = ?`, ['!aabbccdd']);
            assert.equal(node.long_name, 'RepeatNode');
            assert.equal(node.battery_level, 95.5);
            assert.equal(node.last_gateway, '!gw01');

            const pkt = await db2.get(`SELECT * FROM packet_logs WHERE node_id = ?`, ['!aabbccdd']);
            assert.equal(pkt.portnum, 'POSITION_APP');
            assert.equal(pkt.latitude, 25.033);
            assert.equal(pkt.hops_away, 2);
            assert.equal(pkt.source, 'MQTT');

            await db2.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test C — Migration Failure: 模擬必要 Migration 失敗與型別衝突，初始化失敗且不標記為 READY，保留診斷資訊', async () => {
        const dbPath1 = getTempDbPath('test_c_migration_sql_fail');
        const dbPath2 = getTempDbPath('test_c_migration_type_incompat');
        const backupDir = getTempDir('test_c_backups');

        try {
            // 情境 C-1: 模擬 ALTER TABLE 因無效定義 / SQL 錯誤失敗 (絕不可被當成「欄位已存在」吞掉)
            const dbSync = initDatabaseSubsystemSync({
                dbPath: dbPath1,
                backupDir,
                bootstrapSchema: true,
                schemaOptions: {
                    migrations: [
                        ...COLUMN_MIGRATIONS,
                        { t: 'nodes', c: 'broken_col', d: 'INTEGER NOT NULL DEFAULT ( invalid_sql_syntax(' }
                    ]
                }
            });

            await assert.rejects(
                async () => {
                    await dbSync.readyPromise;
                },
                (err) => {
                    assert.match(err.message, /SCHEMA_MIGRATION_FAILED/);
                    assert.equal(err.step, 'COLUMN_MIGRATION');
                    assert.equal(err.table, 'nodes');
                    assert.equal(err.column, 'broken_col');
                    return true;
                }
            );

            assert.equal(dbSync.isSchemaReady, false);
            assert.equal(dbSync.isBootstrapReady(), false);
            assert.equal(dbSync.adapter.state, ADAPTER_STATES.ERROR);
            assert.ok(dbSync.bootstrapError);
            assert.ok(dbSync.adapter.lastError);
            assert.equal(dbSync.adapter.lastError.message, dbSync.bootstrapError.message);

            await dbSync.adapter.emergencyClose(1000);

            // 情境 C-2: 模擬既有資料表欄位型別與預期 Migration 型別不相容
            const dbPre = await createDatabaseSubsystem({ dbPath: dbPath2, backupDir, bootstrapSchema: false });
            await dbPre.adapter.execute(`
                CREATE TABLE nodes (
                    node_id TEXT PRIMARY KEY,
                    long_name TEXT,
                    short_name TEXT,
                    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                    latitude REAL,
                    longitude REAL,
                    is_favorite BLOB
                )
            `);

            await assert.rejects(
                async () => {
                    await dbPre.bootstrapSchema();
                },
                (err) => {
                    assert.match(err.message, /SCHEMA_INCOMPATIBLE_COLUMN/);
                    assert.equal(err.table, 'nodes');
                    assert.equal(err.column, 'is_favorite');
                    return true;
                }
            );

            assert.equal(dbPre.isBootstrapReady(), false);
            assert.equal(dbPre.adapter.state, ADAPTER_STATES.ERROR);
            await dbPre.adapter.emergencyClose(1000);
        } finally {
            cleanupTempDb(dbPath1);
            cleanupTempDb(dbPath2);
            cleanupTempDir(backupDir);
        }
    });

    it('Test D — DDL Failure: 模擬 CREATE TABLE 或 CREATE INDEX 失敗，阻止系統進入正常服務且錯誤不被忽略', async () => {
        const dbPathTableFail = getTempDbPath('test_d_table_fail');
        const dbPathIndexFail = getTempDbPath('test_d_index_fail');
        const backupDir = getTempDir('test_d_backups');

        try {
            // 情境 D-1: CREATE TABLE 失敗
            const dbTableFail = initDatabaseSubsystemSync({
                dbPath: dbPathTableFail,
                backupDir,
                bootstrapSchema: true,
                schemaOptions: {
                    tables: [
                        ...REQUIRED_TABLES,
                        {
                            name: 'corrupted_table_ddl',
                            ddl: 'CREATE TABLE corrupted_table_ddl (id INTEGER PRIMARY KEY, bad_syntax ???)',
                            requiredColumns: ['id']
                        }
                    ]
                }
            });

            let servicesStartedOnTableFail = false;
            await assert.rejects(
                async () => {
                    await executeWithStartupBarrier(dbTableFail, {
                        startHttp: async () => { servicesStartedOnTableFail = true; }
                    });
                },
                (err) => {
                    assert.match(err.message, /SCHEMA_DDL_TABLE_FAILED/);
                    assert.equal(err.step, 'CREATE_TABLE');
                    assert.equal(err.table, 'corrupted_table_ddl');
                    return true;
                }
            );
            assert.equal(servicesStartedOnTableFail, false);
            assert.equal(dbTableFail.isBootstrapReady(), false);
            assert.equal(dbTableFail.adapter.state, ADAPTER_STATES.ERROR);
            await dbTableFail.adapter.emergencyClose(1000);

            // 情境 D-2: CREATE INDEX 失敗 (例如引用不存在的欄位)
            const dbIndexFail = initDatabaseSubsystemSync({
                dbPath: dbPathIndexFail,
                backupDir,
                bootstrapSchema: true,
                schemaOptions: {
                    indexes: [
                        ...REQUIRED_INDEXES,
                        {
                            name: 'idx_nonexistent_column',
                            table: 'packet_logs',
                            ddl: 'CREATE INDEX idx_nonexistent_column ON packet_logs (non_existent_col_xyz DESC)'
                        }
                    ]
                }
            });

            let servicesStartedOnIndexFail = false;
            await assert.rejects(
                async () => {
                    await executeWithStartupBarrier(dbIndexFail, {
                        startHttp: async () => { servicesStartedOnIndexFail = true; }
                    });
                },
                (err) => {
                    assert.match(err.message, /SCHEMA_DDL_INDEX_FAILED/);
                    assert.equal(err.step, 'CREATE_INDEX');
                    assert.equal(err.index, 'idx_nonexistent_column');
                    return true;
                }
            );
            assert.equal(servicesStartedOnIndexFail, false);
            assert.equal(dbIndexFail.isBootstrapReady(), false);
            assert.equal(dbIndexFail.adapter.state, ADAPTER_STATES.ERROR);
            await dbIndexFail.adapter.emergencyClose(1000);
        } finally {
            cleanupTempDb(dbPathTableFail);
            cleanupTempDb(dbPathIndexFail);
            cleanupTempDir(backupDir);
        }
    });

    it('Test E — Initialization Barrier: 人為延遲 Schema 初始化，驗證 API / Socket.IO / MQTT / Background Workers 不會提前啟動', async () => {
        const dbPath = getTempDbPath('test_e_barrier');
        const backupDir = getTempDir('test_e_backups');

        try {
            let releaseBootstrap;
            const bootstrapGate = new Promise((resolve) => {
                releaseBootstrap = resolve;
            });

            const timeline = [];

            const db = initDatabaseSubsystemSync({
                dbPath,
                backupDir,
                bootstrapSchema: true,
                schemaOptions: {
                    beforeSchemaBootstrap: async () => {
                        timeline.push('BOOTSTRAP_WAITING_AT_GATE');
                        await bootstrapGate;
                        timeline.push('BOOTSTRAP_GATE_RELEASED');
                    }
                }
            });

            const barrierPromise = executeWithStartupBarrier(db, {
                startHttp: async () => {
                    assert.equal(db.isBootstrapReady(), true);
                    timeline.push('START_HTTP_API');
                },
                startSocketIo: async () => {
                    assert.equal(db.isBootstrapReady(), true);
                    timeline.push('START_SOCKET_IO');
                },
                startMqtt: async () => {
                    assert.equal(db.isBootstrapReady(), true);
                    timeline.push('START_MQTT');
                },
                startBackgroundWorkers: async () => {
                    assert.equal(db.isBootstrapReady(), true);
                    timeline.push('START_BACKGROUND_WORKERS');
                }
            });

            // 等待進入 beforeSchemaBootstrap gate
            while (!timeline.includes('BOOTSTRAP_WAITING_AT_GATE')) {
                await new Promise(r => setTimeout(r, 10));
            }
            await new Promise(r => setTimeout(r, 40));

            // 驗證在 Schema 初始化完成前，沒有任何服務提前啟動，且 isBootstrapReady() 為 false
            assert.equal(db.isBootstrapReady(), false);
            assert.deepEqual(timeline, ['BOOTSTRAP_WAITING_AT_GATE']);

            // 釋放初始化屏障
            releaseBootstrap();
            const barrierResult = await barrierPromise;

            assert.equal(barrierResult.barrierPassed, true);
            assert.equal(db.isBootstrapReady(), true);
            assert.deepEqual(timeline, [
                'BOOTSTRAP_WAITING_AT_GATE',
                'BOOTSTRAP_GATE_RELEASED',
                'START_HTTP_API',
                'START_SOCKET_IO',
                'START_MQTT',
                'START_BACKGROUND_WORKERS'
            ]);

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test F — Existing Database Compatibility: 舊版結構 Temporary DB 寫入既有資料後執行 Bootstrap & Migration，驗證資料完整保留且新欄位與索引齊全', async () => {
        const dbPath = getTempDbPath('test_f_legacy_compat');
        const backupDir = getTempDir('test_f_backups');

        try {
            // 1. 先以原始 sqlite3 建立舊版結構 (不含後續 26 個 ALTER TABLE 擴充欄位，且含舊版廢棄索引)
            await new Promise((resolve, reject) => {
                const legacyDb = new sqlite3.Database(dbPath, (err) => {
                    if (err) return reject(err);
                    legacyDb.serialize(() => {
                        legacyDb.run(`
                            CREATE TABLE telemetry_data (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                node_id TEXT,
                                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                                battery_level REAL,
                                voltage REAL,
                                temperature REAL,
                                humidity REAL,
                                channel_utilization REAL,
                                air_util_tx REAL,
                                snr REAL,
                                rssi REAL,
                                hop_limit INTEGER,
                                hop_start INTEGER
                            )
                        `);
                        legacyDb.run(`
                            CREATE TABLE nodes (
                                node_id TEXT PRIMARY KEY,
                                long_name TEXT,
                                short_name TEXT,
                                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                                latitude REAL,
                                longitude REAL
                            )
                        `);
                        legacyDb.run(`
                            CREATE TABLE packet_logs (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                node_id TEXT,
                                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                                portnum TEXT,
                                topic TEXT,
                                snr REAL,
                                rssi REAL
                            )
                        `);
                        // 建立一個舊版廢棄索引以驗證會被安全清理
                        legacyDb.run(`CREATE INDEX idx_packet_logs_node_id ON packet_logs(node_id)`);

                        // 寫入舊版歷史資料
                        legacyDb.run(
                            `INSERT INTO nodes (node_id, long_name, short_name, latitude, longitude) VALUES (?, ?, ?, ?, ?)`,
                            ['!legacy01', 'LegacyStationOne', 'LG1', 24.1477, 120.6736]
                        );
                        legacyDb.run(
                            `INSERT INTO packet_logs (node_id, portnum, topic, snr, rssi) VALUES (?, ?, ?, ?, ?)`,
                            ['!legacy01', 'TEXT_MESSAGE_APP', 'msh/tw/2/e/LongFast/!gw00', 8.5, -88]
                        );
                        legacyDb.run(
                            `INSERT INTO telemetry_data (node_id, battery_level, voltage, temperature) VALUES (?, ?, ?, ?)`,
                            ['!legacy01', 82.0, 4.05, 26.4],
                            (insErr) => {
                                legacyDb.close((closeErr) => {
                                    if (insErr || closeErr) return reject(insErr || closeErr);
                                    resolve();
                                });
                            }
                        );
                    });
                });
            });

            // 2. 透過 4.0.1 Database Bootstrap 啟動並遷移舊版 DB
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            assert.equal(db.isBootstrapReady(), true);
            assert.equal(db.schemaReport.columnsAdded.length, COLUMN_MIGRATIONS.length);
            assert.equal(db.schemaReport.verification.verified, true);

            // 3. 驗證廢棄索引已被移除，且所有 11 個必要索引 (包含依賴遷移欄位的 idx_packet_logs_gw_ts 與 idx_packet_logs_ts_hops) 均已建立
            const indexRows = await db.all(`SELECT name FROM sqlite_master WHERE type = 'index'`);
            const indexNames = new Set(indexRows.map(r => r.name));
            for (const obsIdx of OBSOLETE_INDEXES) {
                assert.equal(indexNames.has(obsIdx), false, `廢棄索引 ${obsIdx} 應已被清除`);
            }
            for (const reqIdx of REQUIRED_INDEXES) {
                assert.equal(indexNames.has(reqIdx.name), true, `必要索引 ${reqIdx.name} 應存在`);
            }

            // 4. 驗證舊有資料完整保留且可讀取新欄位預設值
            const legacyNode = await db.get(`SELECT * FROM nodes WHERE node_id = ?`, ['!legacy01']);
            assert.equal(legacyNode.long_name, 'LegacyStationOne');
            assert.equal(legacyNode.latitude, 24.1477);
            assert.equal(legacyNode.is_favorite, 0); // 遷移欄位預設值

            const legacyPacket = await db.get(`SELECT * FROM packet_logs WHERE node_id = ?`, ['!legacy01']);
            assert.equal(legacyPacket.portnum, 'TEXT_MESSAGE_APP');
            assert.equal(legacyPacket.snr, 8.5);
            assert.equal(legacyPacket.gateway_id, null);

            // 5. 驗證遷移後的新欄位可正常寫入與查詢
            await db.run(
                `UPDATE packet_logs SET gateway_id = ?, hops_away = ?, source = ? WHERE id = ?`,
                ['!gw00', 1, 'MQTT', legacyPacket.id]
            );
            const updatedPacket = await db.get(`SELECT * FROM packet_logs WHERE id = ?`, [legacyPacket.id]);
            assert.equal(updatedPacket.gateway_id, '!gw00');
            assert.equal(updatedPacket.hops_away, 1);
            assert.equal(updatedPacket.source, 'MQTT');

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    // =========================================================================
    // Part B: Backup Integrity (Tests G - M)
    // =========================================================================

    it('Test G — WAL Consistent Backup: WAL 模式下寫入資料並執行 Backup，驗證備份檔包含所有已提交資料且通過完整性檢查', async () => {
        const dbPath = getTempDbPath('test_g_wal_backup');
        const backupDir = getTempDir('test_g_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            // 確認在 WAL 模式下運作
            const modeRow = await db.get('PRAGMA journal_mode');
            assert.equal(String(modeRow.journal_mode).toLowerCase(), 'wal');

            // 透過直接執行與 WriteQueue 寫入多筆已提交資料 (此時資料位於 WAL 中尚未 TRUNCATE)
            for (let i = 1; i <= 25; i++) {
                db.queueDbOp(
                    `INSERT INTO nodes (node_id, long_name, short_name, battery_level) VALUES (?, ?, ?, ?)`,
                    [`!walnode_${i}`, `WAL Node ${i}`, `W${i}`, 50 + i]
                );
            }
            await db.flushDbQueue();

            const backupRes = await db.backupManager.performBackup('wal_consistent_backup.db');
            assert.equal(backupRes.success, true);
            assert.equal(backupRes.verify.status, BACKUP_VERIFY_STATUS.VALID);
            assert.ok(backupRes.verify.sizeBytes > 0);
            assert.equal(fs.existsSync(backupRes.targetPath), true);

            // 獨立開啟備份檔案，驗證 25 筆已提交資料全部存在
            const backupRows = await new Promise((resolve, reject) => {
                const roDb = new sqlite3.Database(backupRes.targetPath, sqlite3.OPEN_READONLY, (err) => {
                    if (err) return reject(err);
                    roDb.all(`SELECT * FROM nodes ORDER BY node_id ASC`, (qErr, rows) => {
                        roDb.close(() => {
                            if (qErr) return reject(qErr);
                            resolve(rows);
                        });
                    });
                });
            });

            assert.equal(backupRows.length, 25);

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test H — Concurrent Writes During Backup: 備份執行期間持續透過 WriteQueue 寫入，驗證備份成功且原 DB 保持可讀寫與一致性', async () => {
        const dbPath = getTempDbPath('test_h_concurrent_backup');
        const backupDir = getTempDir('test_h_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            // 先寫入 20 筆基準資料
            for (let i = 1; i <= 20; i++) {
                await db.run(
                    `INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)`,
                    [`!pre_${i}`, `Initial msg ${i}`, 'LongFast']
                );
            }

            // 啟動備份同時併發排入 30 筆新寫入
            const backupPromise = db.backupManager.performBackup('concurrent_backup.db');

            const writePromises = [];
            for (let j = 1; j <= 30; j++) {
                writePromises.push(
                    db.queueDbOp(
                        `INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)`,
                        [`!conc_${j}`, `Concurrent msg ${j}`, 'LongFast']
                    )
                );
            }

            const [backupRes] = await Promise.all([
                backupPromise,
                db.flushDbQueue(),
                ...writePromises
            ]);

            assert.equal(backupRes.success, true);
            assert.equal(backupRes.verify.status, BACKUP_VERIFY_STATUS.VALID);

            // 驗證原資料庫包含全部 50 筆資料且完整性為 ok
            const totalInPrimary = await db.get(`SELECT COUNT(*) AS cnt FROM chat_messages`);
            assert.equal(totalInPrimary.cnt, 50);

            const primaryIntegrity = await db.get(`PRAGMA integrity_check`);
            assert.equal(String(primaryIntegrity.integrity_check).toLowerCase(), 'ok');

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test I — Backup Integrity Failure: 模擬備份驗證失敗与空檔案，驗證不會標記為成功、記錄錯誤且不影響原 DB 運作', async () => {
        const dbPath = getTempDbPath('test_i_integrity_fail');
        const backupDir = getTempDir('test_i_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            await db.run(
                `INSERT INTO nodes (node_id, long_name) VALUES (?, ?)`,
                ['!safe01', 'PrimarySafeNode']
            );

            // 1. 驗證 0-byte 空檔案會被 verifyIntegrity 判定為 CORRUPTED (不可通過)
            const emptyFilePath = path.join(backupDir, 'empty_zero_byte.db');
            fs.writeFileSync(emptyFilePath, '');
            const emptyCheck = await db.backupManager.verifyIntegrity(emptyFilePath);
            assert.equal(emptyCheck.status, BACKUP_VERIFY_STATUS.CORRUPTED);
            assert.match(emptyCheck.details, /INVALID_FILE_SIZE/);
            fs.unlinkSync(emptyFilePath);

            // 2. 模擬 performBackup 產出之檔案未通過 verifyIntegrity
            const originalVerify = db.backupManager.verifyIntegrity.bind(db.backupManager);
            db.backupManager.verifyIntegrity = async () => ({
                status: BACKUP_VERIFY_STATUS.CORRUPTED,
                details: 'SIMULATED_BTREE_CORRUPTION',
                sizeBytes: 4096
            });

            try {
                await assert.rejects(
                    async () => {
                        await db.backupManager.performBackup('corrupted_target.db');
                    },
                    (err) => {
                        assert.match(err.message, /BACKUP_VERIFY_FAILED/);
                        return true;
                    }
                );
            } finally {
                db.backupManager.verifyIntegrity = originalVerify;
            }

            // 驗證失敗狀態已記錄，且壞檔已被清理
            assert.ok(db.backupManager.lastBackupError);
            assert.equal(db.backupManager.lastBackupResult.success, false);
            assert.equal(db.backupManager.lastBackupResult.stage, 'VERIFY_INTEGRITY');
            assert.equal(fs.existsSync(path.join(backupDir, 'corrupted_target.db')), false);

            // 驗證原資料庫完全不受影響，可繼續正常讀寫
            const node = await db.get(`SELECT * FROM nodes WHERE node_id = ?`, ['!safe01']);
            assert.equal(node.long_name, 'PrimarySafeNode');

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test J — Incomplete Backup Cleanup: 模擬備份中途失敗留下半成品檔案，驗證半成品被清除且後續備份可正常成功', async () => {
        const dbPath = getTempDbPath('test_j_partial_cleanup');
        const backupDir = getTempDir('test_j_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            await db.run(`INSERT INTO nodes (node_id, long_name) VALUES (?, ?)`, ['!node_j', 'NodeJ']);

            const partialFileName = 'interrupted_backup.db';
            const partialFullPath = path.join(backupDir, partialFileName);

            // 模擬 maintenanceTask 內執行 VACUUM INTO 時寫入一半失敗並留下殘留檔案
            const origMaintenance = db.adapter.maintenanceTask.bind(db.adapter);
            let failOnce = true;
            db.adapter.maintenanceTask = async (taskName, taskFn) => {
                return origMaintenance(taskName, async (rawContext) => {
                    if (failOnce) {
                        failOnce = false;
                        return taskFn({
                            execute: async (sql) => {
                                if (sql.includes('VACUUM INTO')) {
                                    // 模擬在磁碟產生不完整的半成品檔案後拋出 I/O 錯誤
                                    fs.writeFileSync(partialFullPath, 'PARTIAL_UNFINISHED_SQLITE_BYTES');
                                    throw new Error('SQLITE_IOERR: simulated disk write interruption during VACUUM INTO');
                                }
                                return rawContext.execute(sql);
                            }
                        });
                    }
                    return taskFn(rawContext);
                });
            };

            await assert.rejects(
                async () => {
                    await db.backupManager.performBackup(partialFileName);
                },
                /simulated disk write interruption/
            );

            // 驗證殘留半成品已被清理，不存在於備份目錄中
            assert.equal(fs.existsSync(partialFullPath), false);
            assert.equal(db.backupManager.lastBackupResult.success, false);
            assert.equal(db.backupManager.lastBackupResult.stage, 'VACUUM_INTO');

            // 驗證後續使用相同檔名再次執行備份可正常成功
            const retryRes = await db.backupManager.performBackup(partialFileName);
            assert.equal(retryRes.success, true);
            assert.equal(retryRes.verify.status, BACKUP_VERIFY_STATUS.VALID);
            assert.equal(fs.existsSync(partialFullPath), true);

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test K — Backup Retention: 驗證保留數量與順序、未驗證檔案不計入有效備份、且絕不刪除唯一可用備份', async () => {
        const dbPath = getTempDbPath('test_k_retention');
        const backupDir = getTempDir('test_k_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true,
                config: {
                    backup: {
                        retentionDays: 7,
                        maxBackups: 2
                    }
                }
            });

            await db.run(`INSERT INTO nodes (node_id, long_name) VALUES (?, ?)`, ['!node_k', 'NodeK']);

            // 1. 建立 3 份真實有效備份，並設定不同的修改時間 (b1 最舊、b2 次之、b3 最新)
            const b1 = await db.backupManager.performBackup('backup_1_oldest.db');
            const b2 = await db.backupManager.performBackup('backup_2_middle.db');

            const now = Date.now();
            const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
            const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000);
            fs.utimesSync(b1.targetPath, tenDaysAgo, tenDaysAgo);
            fs.utimesSync(b2.targetPath, fiveDaysAgo, fiveDaysAgo);

            // 放入一個未驗證/損壞的 .db 檔案，確認不會被算進有效備份名額而誤刪真實備份
            const corruptPath = path.join(backupDir, 'unverified_corrupt.db');
            fs.writeFileSync(corruptPath, 'NOT_A_VALID_SQLITE_DB');

            // 執行第 3 份備份觸發 _rotateOldBackups (maxBackups: 2)
            const b3 = await db.backupManager.performBackup('backup_3_newest.db');
            assert.equal(b3.success, true);

            // 最舊的 b1 應被清除，b2 與 b3 保留 (共 2 份有效備份)
            assert.equal(fs.existsSync(b1.targetPath), false, '最舊備份 b1 應依保留順序被刪除');
            assert.equal(fs.existsSync(b2.targetPath), true, '次新備份 b2 應被保留');
            assert.equal(fs.existsSync(b3.targetPath), true, '最新備份 b3 應被保留');

            // 2. 驗證「絕不刪除唯一可用備份」：將 b2 刪除，並將唯一剩下的有效備份 b3 時間改為 365 天前 (遠超 retentionDays: 7)
            fs.unlinkSync(b2.targetPath);
            const oneYearAgo = new Date(now - 365 * 24 * 60 * 60 * 1000);
            fs.utimesSync(b3.targetPath, oneYearAgo, oneYearAgo);

            const rotateSoleResult = await db.backupManager._rotateOldBackups(backupDir);
            assert.equal(rotateSoleResult.retainedCount, 1);
            assert.equal(rotateSoleResult.deletedFiles.length, 0);
            assert.equal(fs.existsSync(b3.targetPath), true, '唯一可用備份即使超過保留天數也絕不可被刪除');

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test L — Backup Restore Verification: 備份後還原至第二個獨立 Temporary DB，比對資料、PRAGMA integrity_check 並驗證可正常讀寫', async () => {
        const sourceDbPath = getTempDbPath('test_l_source');
        const restoredDbPath = getTempDbPath('test_l_restored');
        const backupDir = getTempDir('test_l_backups');

        try {
            const sourceDb = await createDatabaseSubsystem({
                dbPath: sourceDbPath,
                backupDir,
                bootstrapSchema: true
            });

            // 寫入多表測試資料
            await sourceDb.run(
                `INSERT INTO nodes (node_id, long_name, short_name, role, battery_level) VALUES (?, ?, ?, ?, ?)`,
                ['!restore01', 'RestoreTestNode', 'RTN', 'CLIENT', 88.8]
            );
            await sourceDb.run(
                `INSERT INTO packet_logs (node_id, portnum, gateway_id, snr, rssi, hops_away, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['!restore01', 'TELEMETRY_APP', '!gw_rest', 11.2, -75, 1, 'MQTT']
            );

            // 1. 執行備份
            const backupRes = await sourceDb.backupManager.performBackup('for_restore.db');
            assert.equal(backupRes.success, true);

            // 2. 執行還原至第二個獨立 Temporary DB
            const restoreRes = await sourceDb.backupManager.restoreFromBackup(
                backupRes.targetPath,
                restoredDbPath
            );
            assert.equal(restoreRes.success, true);
            assert.equal(restoreRes.verify.status, BACKUP_VERIFY_STATUS.VALID);
            assert.equal(fs.existsSync(restoredDbPath), true);

            await sourceDb.close();

            // 3. 以獨立 Database Subsystem 開啟還原後的 DB，驗證 Schema、資料與可讀寫性
            const restoredDb = await createDatabaseSubsystem({
                dbPath: restoredDbPath,
                backupDir,
                bootstrapSchema: true
            });

            assert.equal(restoredDb.isBootstrapReady(), true);

            const integrityRow = await restoredDb.get(`PRAGMA integrity_check`);
            assert.equal(String(integrityRow.integrity_check).toLowerCase(), 'ok');

            const restoredNode = await restoredDb.get(`SELECT * FROM nodes WHERE node_id = ?`, ['!restore01']);
            assert.equal(restoredNode.long_name, 'RestoreTestNode');
            assert.equal(restoredNode.battery_level, 88.8);

            const restoredPkt = await restoredDb.get(`SELECT * FROM packet_logs WHERE node_id = ?`, ['!restore01']);
            assert.equal(restoredPkt.portnum, 'TELEMETRY_APP');
            assert.equal(restoredPkt.gateway_id, '!gw_rest');

            // 驗證還原後的 DB 可正常寫入新資料
            await restoredDb.run(
                `INSERT INTO nodes (node_id, long_name, short_name) VALUES (?, ?, ?)`,
                ['!restore02', 'PostRestoreWriteNode', 'PRW']
            );
            const countRow = await restoredDb.get(`SELECT COUNT(*) AS cnt FROM nodes`);
            assert.equal(countRow.cnt, 2);

            await restoredDb.close();
        } finally {
            cleanupTempDb(sourceDbPath);
            cleanupTempDb(restoredDbPath);
            cleanupTempDir(backupDir);
        }
    });

    it('Test M — Backup Scheduler Non-Overlap & Shutdown Coordination: 備份執行中再次觸發排程會安全跳過，完成後下一輪排程與優雅關機皆正常', async () => {
        const dbPath = getTempDbPath('test_m_scheduler_non_overlap');
        const backupDir = getTempDir('test_m_backups');

        try {
            const db = await createDatabaseSubsystem({
                dbPath,
                backupDir,
                bootstrapSchema: true
            });

            await db.run(`INSERT INTO nodes (node_id, long_name) VALUES (?, ?)`, ['!node_m', 'NodeM']);

            // 攔截 maintenanceTask 以人為延長第一次備份執行時間
            const origMaintenance = db.adapter.maintenanceTask.bind(db.adapter);
            let releaseFirstBackup;
            const firstBackupGate = new Promise(r => { releaseFirstBackup = r; });
            let vacuumExecutionCount = 0;

            db.adapter.maintenanceTask = async (taskName, taskFn) => {
                return origMaintenance(taskName, async (rawContext) => {
                    return taskFn({
                        execute: async (sql) => {
                            if (sql.includes('VACUUM INTO')) {
                                vacuumExecutionCount++;
                                if (vacuumExecutionCount === 1) {
                                    await firstBackupGate;
                                }
                            }
                            return rawContext.execute(sql);
                        }
                    });
                });
            };

            // 1. 啟動第一個排程備份
            const firstJobPromise = db.backupManager.triggerScheduledBackup('sched_run_1.db');

            while (!db.backupManager.isBackupInProgress) {
                await new Promise(r => setTimeout(r, 10));
            }

            // 2. 當第一個備份仍在執行時，再次觸發排程備份 -> 必須安全跳過不重疊
            const secondJobResult = await db.backupManager.triggerScheduledBackup('sched_run_2_overlap.db');
            assert.equal(secondJobResult.success, false);
            assert.equal(secondJobResult.skipped, true);
            assert.equal(secondJobResult.reason, 'BACKUP_ALREADY_IN_PROGRESS');

            // 同時驗證直接呼叫 performBackup 也會被拒絕
            await assert.rejects(
                async () => {
                    await db.backupManager.performBackup('direct_overlap.db');
                },
                /BACKUP_ALREADY_IN_PROGRESS/
            );

            // 同時驗證備份進行中 (maintenanceInProgress === true) 會保護連線不被 emergencyClose 強行關閉
            assert.equal(db.adapter.getActiveStatus().maintenanceInProgress, true);
            assert.equal(db.adapter.isQuiescent(), false);
            await assert.rejects(
                async () => {
                    await db.adapter.emergencyClose(1000);
                },
                /EMERGENCY_CLOSE_REJECTED/
            );

            // 3. 釋放第一個備份讓其完成
            releaseFirstBackup();
            const firstJobResult = await firstJobPromise;
            assert.equal(firstJobResult.success, true);
            assert.equal(db.backupManager.isBackupInProgress, false);
            assert.equal(vacuumExecutionCount, 1);

            // 4. 第一個備份完成後，再次觸發下一輪排程備份應正常成功
            const thirdJobResult = await db.backupManager.triggerScheduledBackup('sched_run_3_after.db');
            assert.equal(thirdJobResult.success, true);
            assert.equal(thirdJobResult.verify.status, BACKUP_VERIFY_STATUS.VALID);
            assert.equal(vacuumExecutionCount, 2);

            await db.close();
        } finally {
            cleanupTempDb(dbPath);
            cleanupTempDir(backupDir);
        }
    });
});
