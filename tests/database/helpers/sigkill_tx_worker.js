// tests/database/helpers/sigkill_tx_worker.js
// 4.0.2 Cross-Process Abnormal Termination (SIGKILL) 測試專用子行程 Worker
// 支援兩大類跨程序異常終止驗證：
// 1. SQLite WAL Engine Process Death Modes: 'BEFORE_TX' | 'MID_TX_UNCOMMITTED' | 'AFTER_COMMIT'
// 2. Application Packet Transaction Process Death Modes: 'APP_PACKET_TX_MID_FLIGHT' | 'APP_PACKET_TX_AFTER_COMMIT'
// 只對傳入的獨立臨時測試 SQLite DB 進行受控交易階段測試，透過 IPC / stdout 同步精確時間點。

const sqlite3 = require('sqlite3').verbose();
const {
    createDatabaseSubsystem,
    buildMqttPacketTransactionPlan,
    executePacketTransactionPlan
} = require('../../../src/database');

const mode = process.argv[2];
const dbPath = process.argv[3];
const nodeId = process.argv[4] || '!deadbeef';

if (!mode || !dbPath) {
    console.error('Usage: node sigkill_tx_worker.js <mode> <dbPath> [nodeId]');
    process.exit(2);
}

function notifyParent(stage, extra = {}) {
    const payload = { stage, pid: process.pid, mode, nodeId, ...extra };
    if (typeof process.send === 'function') {
        process.send(payload);
    }
    process.stdout.write(`STAGE_READY:${JSON.stringify(payload)}\n`);
}

function runSql(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

(async () => {
    try {
        // =====================================================================
        // 模式群組 A：Application Packet Transaction Process Death (走專案真實 WriteQueue + PacketTransaction + SQLiteAdapter.transaction)
        // =====================================================================
        if (mode === 'APP_PACKET_TX_MID_FLIGHT' || mode === 'APP_PACKET_TX_AFTER_COMMIT') {
            const dbSubsystem = await createDatabaseSubsystem({
                dbPath,
                bootstrapSchema: false,
                config: { queue: { batchChunkSize: 10, flushIntervalMs: 5000 } }
            });

            const plan = buildMqttPacketTransactionPlan({
                fromId: nodeId,
                topic: 'msh/TW/2/e/MediumFast/!gw_app_sigkill',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw_app_sigkill',
                packet: { id: 8801, hop_limit: 2, hop_start: 3, rx_snr: 10.5, rx_rssi: -72 },
                rawHex: 'CAFEBABE',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: 77 }, environment_metrics: { temperature: 27.5, relative_humidity: 64.0 } },
                telemetryData: {
                    batteryLevel: 77,
                    finalVoltage: 4.05,
                    finalCurrent: 130.0,
                    temperature: 27.5,
                    humidity: 64.0,
                    channelUtilization: 9.5,
                    airUtilTx: 1.2,
                    adcVoltage: 4.04
                }
            });

            if (mode === 'APP_PACKET_TX_MID_FLIGHT') {
                // 攔截 SQLiteAdapter.transaction 內部的 tx.execute：
                // 讓此封包交易的第 0 筆 (INSERT nodes)、第 1 筆 (INSERT packet_logs)、第 2 筆 (UPDATE nodes) 真實寫入 SQLite 交易中，
                // 並在準備執行第 3 筆 (INSERT telemetry_data) 與 COMMIT 前暫停，通知父行程發送 SIGKILL！
                const origTransaction = dbSubsystem.adapter.transaction.bind(dbSubsystem.adapter);
                dbSubsystem.adapter.transaction = async (txFn) => {
                    return origTransaction(async (tx) => {
                        let stmtCounter = 0;
                        const wrappedTx = {
                            ...tx,
                            execute: async (sql, params) => {
                                stmtCounter++;
                                if (stmtCounter === 4) {
                                    notifyParent('READY_FOR_SIGKILL_APP_PACKET_TX_MID_FLIGHT', { executedStatementsBeforeKill: 3 });
                                    await new Promise(() => {}); // 永久掛起等待父行程 SIGKILL
                                }
                                return tx.execute(sql, params);
                            }
                        };
                        return txFn(wrappedTx);
                    });
                };

                executePacketTransactionPlan(plan, {
                    enqueuePacketTransaction: dbSubsystem.queuePacketTransaction.bind(dbSubsystem),
                    batchEmit: () => {},
                    recordLivePacketAnalytics: () => {},
                    logger: { log: () => {}, error: () => {} }
                });

                await dbSubsystem.flushDbQueue();
                return;
            }

            if (mode === 'APP_PACKET_TX_AFTER_COMMIT') {
                await new Promise((resolve, reject) => {
                    executePacketTransactionPlan(
                        plan,
                        {
                            enqueuePacketTransaction: dbSubsystem.queuePacketTransaction.bind(dbSubsystem),
                            batchEmit: () => {},
                            recordLivePacketAnalytics: () => {},
                            logger: { log: () => {}, error: () => {} }
                        },
                        (err) => {
                            if (err) return reject(err);
                            resolve();
                        }
                    );
                    dbSubsystem.flushDbQueue().catch(reject);
                });

                notifyParent('READY_FOR_SIGKILL_APP_PACKET_TX_AFTER_COMMIT');
                setInterval(() => {}, 1000);
                return;
            }
        }

        // =====================================================================
        // 模式群組 B：SQLite WAL Engine Process Death (原生 sqlite3 連線交易測試)
        // =====================================================================
        const db = new sqlite3.Database(dbPath);
        await runSql(db, 'PRAGMA journal_mode = WAL');
        await runSql(db, 'PRAGMA synchronous = NORMAL');
        await runSql(db, 'PRAGMA busy_timeout = 5000');

        if (mode === 'BEFORE_TX') {
            // 階段 1：連線已開啟，但尚未開始 BEGIN IMMEDIATE 交易
            notifyParent('READY_FOR_SIGKILL_BEFORE_TX');
            setInterval(() => {}, 1000);
            return;
        }

        if (mode === 'MID_TX_UNCOMMITTED') {
            // 階段 2：啟動 BEGIN IMMEDIATE 並寫入封包的前四張關聯表（nodes, packet_logs, chat_messages, neighbors），但故意停在 telemetry_data 與 COMMIT 之前
            await runSql(db, 'BEGIN IMMEDIATE TRANSACTION');
            await runSql(
                db,
                `INSERT INTO nodes (node_id, long_name, short_name, last_seen, last_topic, channel, hop_limit, hop_start, last_gateway, battery_level, voltage, temperature, humidity)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nodeId, 'UncommittedGhostNode', 'GHOST', 'msh/TW/2/e/MediumFast/!gw', 'MediumFast', 3, 3, '!gw', 88, 4.12, 26.5, 65.0]
            );
            await runSql(
                db,
                `INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex, hops_away)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nodeId, 'TELEMETRY_APP', 'msh/TW/2/e/MediumFast/!gw', '!gw', 9.5, -75, 3, 3, '{"uncommitted":true}', 'AABBCCDD', 0]
            );
            await runSql(
                db,
                `INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)`,
                [nodeId, 'UNCOMMITTED_MESSAGE_SHOULD_ROLLBACK', 'MediumFast']
            );
            await runSql(
                db,
                `INSERT INTO neighbors (node_id, neighbor_id, snr) VALUES (?, ?, ?)`,
                [nodeId, '!99999999', 7.25]
            );

            // 通知父行程：目前正處於交易中段（已寫入 4 張表但尚未寫入 telemetry_data 且尚未 COMMIT）
            notifyParent('READY_FOR_SIGKILL_MID_TX');
            setInterval(() => {}, 1000);
            return;
        }

        if (mode === 'AFTER_COMMIT') {
            // 階段 3：完整執行封包交易並完成 COMMIT，於 COMMIT 完成瞬間通知父行程執行 SIGKILL
            await runSql(db, 'BEGIN IMMEDIATE TRANSACTION');
            await runSql(
                db,
                `INSERT INTO nodes (node_id, long_name, short_name, last_seen, last_topic, channel, hop_limit, hop_start, last_gateway, battery_level, voltage, temperature, humidity)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(node_id) DO UPDATE SET long_name=excluded.long_name, short_name=excluded.short_name, battery_level=excluded.battery_level`,
                [nodeId, 'CommittedSurvivorNode', 'SURV', 'msh/TW/2/e/MediumFast/!gw', 'MediumFast', 3, 3, '!gw', 95, 4.18, 24.5, 55.0]
            );
            await runSql(
                db,
                `INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex, hops_away)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nodeId, 'TELEMETRY_APP', 'msh/TW/2/e/MediumFast/!gw', '!gw', 11.0, -68, 3, 3, '{"committed":true}', '11223344', 0]
            );
            await runSql(
                db,
                `INSERT INTO telemetry_data (node_id, battery_level, voltage, temperature, humidity, channel_utilization, air_util_tx, snr, rssi, current, hop_limit, hop_start, adc_voltage)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nodeId, 95, 4.18, 24.5, 55.0, 12.3, 1.4, 11.0, -68, 120.0, 3, 3, 4.18]
            );
            await runSql(db, 'COMMIT');

            notifyParent('READY_FOR_SIGKILL_AFTER_COMMIT');
            setInterval(() => {}, 1000);
            return;
        }

        console.error(`Unknown mode: ${mode}`);
        process.exit(3);
    } catch (err) {
        console.error('Worker error:', err);
        process.exit(1);
    }
})();

