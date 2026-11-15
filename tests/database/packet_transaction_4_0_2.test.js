// tests/database/packet_transaction_4_0_2.test.js
// Meshtastic-DashBoard 4.0.2 — Packet Transaction Boundary, Turso/Backup Policy & Cross-Process Integration Suite
// 嚴格遵守開發環境隔離：所有測試僅在 os.tmpdir() 建立與銷毀獨立 Temporary SQLite DB、臨時通訊埠與子行程，絕不接觸正式環境。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const protobuf = require('protobufjs');

const {
    createDatabaseSubsystem,
    buildMqttPacketTransactionPlan,
    buildRfTunnelPacketTransactionPlan,
    executePacketTransactionPlan,
    ITEM_STATUS
} = require('../../src/database');
const sqliteConfig = require('../../src/database/sqlite.config');

function createTempPath(prefix = 'mesh_402_test', ext = '.db') {
    return path.join(
        os.tmpdir(),
        `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
    );
}

function cleanupDbFiles(dbPath) {
    if (!dbPath) return;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const candidate = `${dbPath}${suffix}`;
        try {
            if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
        } catch (_) {}
    }
}

function cleanupDirRecursive(dirPath) {
    if (!dirPath) return;
    try {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
    } catch (_) {}
}

function assertDataConservation(metrics) {
    const totalPending = metrics.queuedCount + metrics.retryPendingCount + metrics.inFlightCount;
    const totalUncommitted = totalPending + metrics.uncommittedErrorCount;
    const expectedAccepted = metrics.totalCommitted + metrics.totalQuarantined + totalUncommitted;
    assert.equal(
        metrics.totalAccepted,
        expectedAccepted,
        `Data Conservation 違規: totalAccepted=${metrics.totalAccepted} !== expected=${expectedAccepted}`
    );
    assert.equal(metrics.conservationCheck, true);
}

/**
 * 建立輕量級原生 TCP MQTT 3.1.1 測試 Broker（無外部依賴，僅監聽 127.0.0.1 臨時埠）
 * 支援 CONNECT -> CONNACK、SUBSCRIBE -> SUBACK、PINGREQ -> PINGRESP 與主動 PUBLISH Protobuf 封包
 */
function encodeMqttRemainingLength(length) {
    const bytes = [];
    let x = length;
    do {
        let encodedByte = x % 128;
        x = Math.floor(x / 128);
        if (x > 0) {
            encodedByte = encodedByte | 128;
        }
        bytes.push(encodedByte);
    } while (x > 0);
    return Buffer.from(bytes);
}

function buildMqttPublishPacket(topic, payloadBuffer, protocolVersion = 4) {
    const topicBuf = Buffer.from(topic, 'utf8');
    const topicLenBuf = Buffer.alloc(2);
    topicLenBuf.writeUInt16BE(topicBuf.length, 0);
    // MQTT v5.0 PUBLISH (QoS 0) 在 Topic Name 後方包含 1-byte Properties Length (0x00)
    const propsBuf = protocolVersion === 5 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const body = Buffer.concat([topicLenBuf, topicBuf, propsBuf, payloadBuffer]);
    const fixedHeader = Buffer.from([0x30]); // PUBLISH QoS 0
    const remLen = encodeMqttRemainingLength(body.length);
    return Buffer.concat([fixedHeader, remLen, body]);
}

function startLocalMockMqttBroker() {
    const sockets = new Set();
    let clientProtocolVersion = 4;
    let subscribedResolve = null;
    const subscribedPromise = new Promise((resolve) => {
        subscribedResolve = resolve;
    });

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});

        socket.on('data', (chunk) => {
            let offset = 0;
            while (offset < chunk.length) {
                const packetType = chunk[offset] & 0xf0;
                // 解碼 MQTT Remaining Length
                let multiplier = 1;
                let remLen = 0;
                let idx = offset + 1;
                let encodedByte = 0;
                do {
                    if (idx >= chunk.length) return;
                    encodedByte = chunk[idx++];
                    remLen += (encodedByte & 127) * multiplier;
                    multiplier *= 128;
                } while ((encodedByte & 128) !== 0);

                const packetEnd = idx + remLen;
                if (packetEnd > chunk.length) return;

                if (packetType === 0x10) {
                    // CONNECT: Variable Header 為 [0x00, 0x04, 'M', 'Q', 'T', 'T', protocolLevel]
                    const protoNameLen = chunk.readUInt16BE(idx);
                    const protoLevel = chunk[idx + 2 + protoNameLen];
                    clientProtocolVersion = protoLevel === 5 ? 5 : 4;
                    if (clientProtocolVersion === 5) {
                        // MQTT v5.0 CONNACK: [0x20, remLen=3, ackFlags=0, reasonCode=0, propsLen=0]
                        socket.write(Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]));
                    } else {
                        // MQTT v3.1.1 CONNACK: [0x20, remLen=2, ackFlags=0, returnCode=0]
                        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
                    }
                } else if (packetType === 0x80) {
                    // SUBSCRIBE -> 讀取 Packet Identifier 並回傳 SUBACK (0x90)
                    const pktIdHi = chunk[idx];
                    const pktIdLo = chunk[idx + 1];
                    if (clientProtocolVersion === 5) {
                        // MQTT v5.0 SUBACK: [0x90, remLen=4, pktIdHi, pktIdLo, propsLen=0, reasonCode=0]
                        socket.write(Buffer.from([0x90, 0x04, pktIdHi, pktIdLo, 0x00, 0x00]));
                    } else {
                        socket.write(Buffer.from([0x90, 0x03, pktIdHi, pktIdLo, 0x00]));
                    }
                    if (subscribedResolve) {
                        subscribedResolve(socket);
                        subscribedResolve = null;
                    }
                } else if (packetType === 0xc0) {
                    // PINGREQ -> 回傳 PINGRESP (0xd0, 0x00)
                    socket.write(Buffer.from([0xd0, 0x00]));
                } else if (packetType === 0xe0) {
                    // DISCONNECT
                    socket.end();
                }

                offset = packetEnd;
            }
        });
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                port: address.port,
                url: `mqtt://127.0.0.1:${address.port}`,
                waitForSubscription: () => subscribedPromise,
                publish(topic, payloadBuffer) {
                    const pkt = buildMqttPublishPacket(topic, payloadBuffer, clientProtocolVersion);
                    for (const s of sockets) {
                        if (!s.destroyed) s.write(pkt);
                    }
                },
                async close() {
                    for (const s of sockets) {
                        try { s.destroy(); } catch (_) {}
                    }
                    sockets.clear();
                    await new Promise((r) => server.close(() => r()));
                }
            });
        });
    });
}

function getFreeTcpPort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
                } catch (err) {
                    reject(new Error(`Invalid JSON from ${url}: ${body}`));
                }
            });
        });
        req.on('error', reject);
    });
}

describe('Meshtastic-DashBoard 4.0.2 — Packet Transaction Boundary & Cross-Process Integration Suite', () => {

    // =========================================================================
    // 一、4.0.2 Packet Transaction Boundary 整合測試 (10 個必要情境)
    // =========================================================================

    it('Test 4.0.2-1 — Multi-Table Packet Commit Success: 單一封包的多筆關聯表寫入全部成功時，所有相關表紀錄皆原子存在', async () => {
        const dbPath = createTempPath('pkt_tx_success');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            const emittedEvents = [];
            const analyticsCalls = [];
            const hooks = {
                enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                batchEmit: (type, payload) => emittedEvents.push({ type, payload }),
                recordLivePacketAnalytics: (port, snr, rssi, temp, hum) => analyticsCalls.push({ port, snr, rssi, temp, hum }),
                logger: { log: () => {}, error: () => {} }
            };

            // 1. TELEMETRY_APP 封包 (同時寫入 nodes 基礎狀態、packet_logs、nodes 遙測欄位、telemetry_data 共 4 筆 SQL)
            const telePlan = buildMqttPacketTransactionPlan({
                fromId: '!11223344',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 101, hop_limit: 2, hop_start: 3, rx_snr: 8.5, rx_rssi: -82 },
                rawHex: '0A0B0C0D',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: 87 }, environment_metrics: { temperature: 25.4, relative_humidity: 61.2 } },
                telemetryData: {
                    batteryLevel: 87,
                    finalVoltage: 4.11,
                    finalCurrent: 145.0,
                    temperature: 25.4,
                    humidity: 61.2,
                    channelUtilization: 11.5,
                    airUtilTx: 1.8,
                    adcVoltage: 4.09
                }
            });
            assert.equal(telePlan.statements.length, 4, 'TELEMETRY_APP 交易單位應包含 4 筆關聯 SQL');

            // 2. TEXT_MESSAGE_APP 封包 (同時寫入 nodes、chat_messages、packet_logs 共 3 筆 SQL)
            const chatPlan = buildMqttPacketTransactionPlan({
                fromId: '!11223344',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 102, hop_limit: 3, hop_start: 3, rx_snr: 10.0, rx_rssi: -70 },
                rawHex: '1A2B3C4D',
                decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                payloadObj: { text: 'Hello Atomic Mesh!', channel_name: 'MediumFast' }
            });
            assert.equal(chatPlan.statements.length, 3, 'TEXT_MESSAGE_APP 交易單位應包含 3 筆關聯 SQL');

            // 3. NEIGHBORINFO_APP 封包 (同時寫入 nodes、2 筆 neighbors、packet_logs 共 4 筆 SQL)
            const neighborPlan = buildMqttPacketTransactionPlan({
                fromId: '!11223344',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 103, hop_limit: 1, hop_start: 3, rx_snr: 6.0, rx_rssi: -90 },
                rawHex: '55667788',
                decodedData: { portnum: 'NEIGHBORINFO_APP', channel_name: 'MediumFast' },
                payloadObj: { neighbors: [{ node_id: 0x22334455, snr: 7.5 }, { node_id: 0x33445566, snr: -2.0 }] },
                neighborList: [
                    { neighborId: '!22334455', snr: 7.5 },
                    { neighborId: '!33445566', snr: -2.0 }
                ]
            });
            assert.equal(neighborPlan.statements.length, 4, 'NEIGHBORINFO_APP 交易單位應包含 4 筆關聯 SQL');

            executePacketTransactionPlan(telePlan, hooks);
            executePacketTransactionPlan(chatPlan, hooks);
            executePacketTransactionPlan(neighborPlan, hooks);

            await db.flushDbQueue();

            const nodeRow = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!11223344']);
            assert.ok(nodeRow, 'nodes 表應存在 !11223344');
            assert.equal(nodeRow.battery_level, 87);
            assert.equal(nodeRow.voltage, 4.11);
            assert.equal(nodeRow.temperature, 25.4);
            assert.equal(nodeRow.humidity, 61.2);

            const pktLogs = await db.all('SELECT * FROM packet_logs WHERE node_id = ? ORDER BY id ASC', ['!11223344']);
            assert.equal(pktLogs.length, 3, 'packet_logs 應有 3 筆紀錄');

            const teleRows = await db.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!11223344']);
            assert.equal(teleRows.length, 1, 'telemetry_data 應有 1 筆紀錄');
            assert.equal(teleRows[0].battery_level, 87);

            const chatRows = await db.all('SELECT * FROM chat_messages WHERE node_id = ?', ['!11223344']);
            assert.equal(chatRows.length, 1, 'chat_messages 應有 1 筆紀錄');
            assert.equal(chatRows[0].message, 'Hello Atomic Mesh!');

            const nbRows = await db.all('SELECT * FROM neighbors WHERE node_id = ? ORDER BY neighbor_id ASC', ['!11223344']);
            assert.equal(nbRows.length, 2, 'neighbors 應有 2 筆紀錄');
            assert.deepEqual(nbRows.map(r => r.neighbor_id), ['!22334455', '!33445566']);

            assert.equal(analyticsCalls.length, 3, '3 個已提交封包應觸發 3 次戰情累加');
            assert.ok(emittedEvents.length >= 6, 'COMMIT 後應觸發對應之 batchEmit 推播');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    it('Test 4.0.2-2 & 4.0.2-3 — Atomic Rollback & Zero Partial State: 單一封包多筆寫入中任一步驟失敗時，整個封包全部回滾且不留任何部分資料', async () => {
        const dbPath = createTempPath('pkt_tx_rollback');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            // 在 telemetry_data 建立一個針對特定測試錯誤標記的 SQLite Trigger，模擬封包交易第 4 步寫入時發生約束失敗
            await db.run(`
                CREATE TRIGGER trg_reject_invalid_telemetry
                BEFORE INSERT ON telemetry_data
                WHEN NEW.battery_level < -900
                BEGIN
                    SELECT RAISE(ABORT, 'SIMULATED_TELEMETRY_STEP_CONSTRAINT_FAILURE');
                END;
            `);

            const emittedEvents = [];
            const analyticsCalls = [];
            let callbackErr = null;

            const failingTelePlan = buildMqttPacketTransactionPlan({
                fromId: '!bad00001',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 201, hop_limit: 3, hop_start: 3, rx_snr: 5.0, rx_rssi: -95 },
                rawHex: 'DEADBEEF',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: -999 } },
                telemetryData: {
                    batteryLevel: -999, // 第 1 步 (INSERT nodes)、第 2 步 (INSERT packet_logs)、第 3 步 (UPDATE nodes) 均合法，但第 4 步 (INSERT telemetry_data) 觸發 ABORT!
                    finalVoltage: 3.99,
                    finalCurrent: 50,
                    temperature: 22.0,
                    humidity: 50.0,
                    channelUtilization: 5.0,
                    airUtilTx: 0.5,
                    adcVoltage: 3.99
                }
            });

            executePacketTransactionPlan(
                failingTelePlan,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    batchEmit: (type, payload) => emittedEvents.push({ type, payload }),
                    recordLivePacketAnalytics: (port, snr, rssi) => analyticsCalls.push({ port, snr, rssi }),
                    logger: { log: () => {}, error: () => {} }
                },
                (err) => {
                    callbackErr = err;
                }
            );

            await db.flushDbQueue();

            // 驗證回呼收到錯誤，且明確指出失敗於第 4 筆語句 (index = 3)
            assert.ok(callbackErr, '失敗封包的回呼必須收到錯誤');
            assert.match(callbackErr.message, /QUARANTINED_CONSTRAINT_ERROR/);
            assert.equal(callbackErr.failedStatementIndex, 3, '應精確記錄失敗發生於第 4 筆 SQL (index=3)');

            // 關鍵驗證 (1.5 #2 & #3)：前面第 1 步寫入的 nodes 與第 2 步寫入的 packet_logs 必須完全被 ROLLBACK，不留任何殘留紀錄！
            const ghostNode = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!bad00001']);
            const ghostLogs = await db.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!bad00001']);
            const ghostTele = await db.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!bad00001']);

            assert.equal(ghostNode, null, '回滾後 nodes 表絕不可殘留 !bad00001 的部分寫入');
            assert.equal(ghostLogs.length, 0, '回滾後 packet_logs 表絕不可殘留 !bad00001 的部分寫入');
            assert.equal(ghostTele.length, 0, '回滾後 telemetry_data 表絕不可殘留 !bad00001 的部分寫入');

            // 關鍵驗證 (1.4 & 1.5 #7)：失敗回滾的封包絕不可觸發 batchEmit 或戰情累加
            assert.equal(emittedEvents.length, 0, '回滾封包絕不可觸發任何 WebSocket batchEmit');
            assert.equal(analyticsCalls.length, 0, '回滾封包絕不可觸發任何戰情分析累加');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    it('Test 4.0.2-4 & 4.0.2-5 — Multi-Packet Batch & Indivisible Binary Isolation: 批次中單一封包失敗時，Binary Isolation 絕不拆開封包內部語句，且同批其他有效封包全數成功提交', async () => {
        const dbPath = createTempPath('pkt_tx_batch_iso');
        const db = await createDatabaseSubsystem({
            dbPath,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 20, flushIntervalMs: 5000 } }
        });

        try {
            await db.run(`
                CREATE TRIGGER trg_reject_bad_chat
                BEFORE INSERT ON packet_logs
                WHEN NEW.node_id = '!bad_pkt_3'
                BEGIN
                    SELECT RAISE(ABORT, 'SIMULATED_PACKET_LOG_CONSTRAINT_ON_PKT_3');
                END;
            `);

            const results = [];
            const emits = [];
            const hooks = {
                enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                batchEmit: (type, payload) => emits.push({ type, payload }),
                recordLivePacketAnalytics: () => {},
                logger: { log: () => {}, error: () => {} }
            };

            const packetNodes = ['!good_pkt_1', '!good_pkt_2', '!bad_pkt_3', '!good_pkt_4', '!good_pkt_5'];
            for (const nodeId of packetNodes) {
                const plan = buildMqttPacketTransactionPlan({
                    fromId: nodeId,
                    topic: 'msh/TW/2/e/MediumFast/!gw01',
                    resolvedChannel: 'MediumFast',
                    gatewayId: '!gw01',
                    packet: { id: 300, hop_limit: 3, hop_start: 3, rx_snr: 7.0, rx_rssi: -80 },
                    rawHex: 'AABBCC',
                    decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                    payloadObj: { text: `Message from ${nodeId}`, channel_name: 'MediumFast' }
                });
                // 順序為：Statement 0 (INSERT nodes) -> Statement 1 (INSERT chat_messages) -> Statement 2 (INSERT packet_logs)
                // 對於 !bad_pkt_3，Statement 0 與 Statement 1 會先執行，直到 Statement 2 (packet_logs) 才觸發錯誤！
                // 若 Binary Isolation 錯誤地拆開同一封包的 statements，!bad_pkt_3 的 nodes 與 chat_messages 就會被提交！
                executePacketTransactionPlan(plan, hooks, (err) => {
                    results.push({ nodeId, ok: !err, err });
                });
            }

            // 一次性 Flush 包含 5 個多語句封包的同一批次
            await db.flushDbQueue();

            assert.equal(results.length, 5, '5 個封包都應完成回呼');
            const goodResults = results.filter(r => r.ok).map(r => r.nodeId);
            const badResults = results.filter(r => !r.ok);

            assert.deepEqual(goodResults, ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);
            assert.equal(badResults.length, 1);
            assert.equal(badResults[0].nodeId, '!bad_pkt_3');
            assert.equal(badResults[0].err.failedStatementIndex, 2, '應在封包的第 3 筆語句 (packet_logs) 觸發失敗');

            // 驗證 Binary Isolation 沒有把 !bad_pkt_3 的前兩筆語句 (nodes, chat_messages) 拆開提交！
            const badNodeRow = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!bad_pkt_3']);
            const badChatRows = await db.all('SELECT * FROM chat_messages WHERE node_id = ?', ['!bad_pkt_3']);
            const badLogRows = await db.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!bad_pkt_3']);
            assert.equal(badNodeRow, null, 'Binary Isolation 絕不可將失敗封包的第 1 筆 nodes 語句單獨提交');
            assert.equal(badChatRows.length, 0, 'Binary Isolation 絕不可將失敗封包的第 2 筆 chat_messages 語句單獨提交');
            assert.equal(badLogRows.length, 0, 'Binary Isolation 絕不可將失敗封包的第 3 筆 packet_logs 語句提交');

            // 驗證其他 4 個有效封包的所有關聯表 (nodes, chat_messages, packet_logs) 均完整提交
            const committedNodes = await db.all('SELECT node_id FROM nodes ORDER BY node_id ASC');
            const committedChats = await db.all('SELECT node_id, message FROM chat_messages ORDER BY node_id ASC');
            const committedLogs = await db.all('SELECT node_id FROM packet_logs ORDER BY node_id ASC');

            assert.deepEqual(committedNodes.map(r => r.node_id), ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);
            assert.deepEqual(committedChats.map(r => r.node_id), ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);
            assert.deepEqual(committedLogs.map(r => r.node_id), ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);

            const qMetrics = db.writeQueue.getMetrics();
            assert.equal(qMetrics.totalAccepted, 5);
            assert.equal(qMetrics.totalCommitted, 4);
            assert.equal(qMetrics.totalQuarantined, 1);
            assert.equal(db.writeQueue.quarantinedItems[0].isTransactionUnit, true);
            assert.equal(db.writeQueue.quarantinedItems[0].statements.length, 3);
            assertDataConservation(qMetrics);
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    it('Test 4.0.2-6 & 4.0.2-7 — Callback Exactly-Once & Post-Commit Ordering Guarantee: 每個封包回呼最多只觸發一次，且未提交前絕不提前回報成功或觸發推播', async () => {
        const dbPath = createTempPath('pkt_tx_cb_order');
        const db = await createDatabaseSubsystem({
            dbPath,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 50, flushIntervalMs: 10000 } }
        });

        try {
            const timeline = [];
            let cbInvocationCount = 0;

            // 包裝 adapter.transaction 以觀測底層 COMMIT 完成的時間點
            const origTransaction = db.adapter.transaction.bind(db.adapter);
            db.adapter.transaction = async (txFn) => {
                timeline.push('TX_BEGIN');
                const res = await origTransaction(async (tx) => {
                    const innerRes = await txFn(tx);
                    timeline.push('TX_STATEMENTS_EXECUTED_PRE_COMMIT');
                    return innerRes;
                });
                timeline.push('TX_COMMIT_COMPLETED');
                return res;
            };

            const plan = buildMqttPacketTransactionPlan({
                fromId: '!cb_node_01',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 401, hop_limit: 3, hop_start: 3, rx_snr: 9.0, rx_rssi: -77 },
                rawHex: '01020304',
                decodedData: { portnum: 'NODEINFO_APP', channel_name: 'MediumFast' },
                payloadObj: { long_name: 'Order Check Node', short_name: 'ORD1', role: 'ROUTER' },
                nodeInfoData: {
                    long_name: 'Order Check Node',
                    short_name: 'ORD1',
                    role: 'ROUTER',
                    hw_model: 'TBEAM',
                    firmware_version: '2.5.0',
                    firmware_build_num: '12345'
                }
            });

            executePacketTransactionPlan(
                plan,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    batchEmit: (type) => timeline.push(`BATCH_EMIT:${type}`),
                    recordLivePacketAnalytics: () => timeline.push('ANALYTICS_RECORDED'),
                    logger: { log: () => timeline.push('POST_COMMIT_LOG'), error: () => {} }
                },
                (err) => {
                    cbInvocationCount++;
                    timeline.push(err ? 'USER_CALLBACK_ERROR' : 'USER_CALLBACK_SUCCESS');
                }
            );

            // 入列後、尚未 Flush 時，絕不可提前觸發任何推播、戰情累加或成功回呼
            assert.equal(cbInvocationCount, 0, '尚未 Flush/COMMIT 前，回呼次數必須為 0');
            assert.deepEqual(timeline, [], '尚未 COMMIT 前，不得有任何推播或戰情副作用');

            await db.flushDbQueue();

            assert.equal(cbInvocationCount, 1, '封包交易提交後，回呼必須恰好觸發 1 次');

            const commitIdx = timeline.indexOf('TX_COMMIT_COMPLETED');
            const analyticsIdx = timeline.indexOf('ANALYTICS_RECORDED');
            const firstEmitIdx = timeline.findIndex(e => e.startsWith('BATCH_EMIT:'));
            const cbIdx = timeline.indexOf('USER_CALLBACK_SUCCESS');

            assert.ok(commitIdx !== -1, '必須經歷 TX_COMMIT_COMPLETED');
            assert.ok(analyticsIdx > commitIdx, '戰情累加必須發生於 TX_COMMIT_COMPLETED 之後');
            assert.ok(firstEmitIdx > commitIdx, 'WebSocket 推播必須發生於 TX_COMMIT_COMPLETED 之後');
            assert.ok(cbIdx > commitIdx, '使用者成功回呼必須發生於 TX_COMMIT_COMPLETED 之後');
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    it('Test 4.0.2-8 — High-Concurrency Multi-Packet Ingestion: 多封包高併發快速連續進入時，不會互相污染或交錯破壞交易完整性', async () => {
        const dbPath = createTempPath('pkt_tx_concurrent');
        const db = await createDatabaseSubsystem({
            dbPath,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 12, flushIntervalMs: 20 } }
        });

        try {
            const totalPackets = 60;
            const settledPromises = [];

            for (let i = 1; i <= totalPackets; i++) {
                const nodeId = `!conc${String(i).padStart(4, '0')}`;
                const isTelemetry = (i % 2 === 0);
                const plan = isTelemetry
                    ? buildMqttPacketTransactionPlan({
                        fromId: nodeId,
                        topic: 'msh/TW/2/e/MediumFast/!gw_conc',
                        resolvedChannel: 'MediumFast',
                        gatewayId: '!gw_conc',
                        packet: { id: 1000 + i, hop_limit: 2, hop_start: 3, rx_snr: 6.5, rx_rssi: -85 },
                        rawHex: 'AABB',
                        decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                        payloadObj: { device_metrics: { battery_level: i } },
                        telemetryData: {
                            batteryLevel: i,
                            finalVoltage: 4.0 + (i * 0.001),
                            finalCurrent: 100 + i,
                            temperature: 20 + (i * 0.1),
                            humidity: 50 + (i * 0.2),
                            channelUtilization: 10,
                            airUtilTx: 1,
                            adcVoltage: 4.0
                        }
                    })
                    : buildMqttPacketTransactionPlan({
                        fromId: nodeId,
                        topic: 'msh/TW/2/e/MediumFast/!gw_conc',
                        resolvedChannel: 'MediumFast',
                        gatewayId: '!gw_conc',
                        packet: { id: 1000 + i, hop_limit: 1, hop_start: 3, rx_snr: 4.5, rx_rssi: -91 },
                        rawHex: 'CCDD',
                        decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                        payloadObj: { text: `Concurrent msg #${i}`, channel_name: 'MediumFast' }
                    });

                settledPromises.push(
                    new Promise((resolve, reject) => {
                        executePacketTransactionPlan(
                            plan,
                            {
                                enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                                batchEmit: () => {},
                                recordLivePacketAnalytics: () => {},
                                logger: { log: () => {}, error: () => {} }
                            },
                            (err, res) => {
                                if (err) return reject(err);
                                resolve(res);
                            }
                        );
                    })
                );
            }

            await db.flushDbQueue();
            await Promise.all(settledPromises);

            const nodesCount = await db.get('SELECT COUNT(*) as c FROM nodes');
            const logsCount = await db.get('SELECT COUNT(*) as c FROM packet_logs');
            const teleCount = await db.get('SELECT COUNT(*) as c FROM telemetry_data');
            const chatCount = await db.get('SELECT COUNT(*) as c FROM chat_messages');

            assert.equal(nodesCount.c, 60, '60 個併發節點必須全數寫入 nodes');
            assert.equal(logsCount.c, 60, '60 筆封包日誌必須全數寫入 packet_logs');
            assert.equal(teleCount.c, 30, '30 筆遙測封包必須全數寫入 telemetry_data');
            assert.equal(chatCount.c, 30, '30 筆聊天封包必須全數寫入 chat_messages');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    it('Test 4.0.2-9 & 4.0.2-10 — Unknown Node Pre-NODEINFO Arrival & COALESCE / RF Tunnel Semantics: 未知節點先收到封包可正常寫入，後續 NODEINFO 與 COALESCE 更新語意完全相容', async () => {
        const dbPath = createTempPath('pkt_tx_unknown_node');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            const hooks = {
                enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                batchEmit: () => {},
                recordLivePacketAnalytics: () => {},
                logger: { log: () => {}, error: () => {} }
            };

            const unknownNodeId = '!f00dbabe';

            // Step 1: 未知節點尚未發送過 NODEINFO，先收到 POSITION_APP 封包
            const posPlan = buildMqttPacketTransactionPlan({
                fromId: unknownNodeId,
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 501, hop_limit: 2, hop_start: 3, rx_snr: 11.0, rx_rssi: -72 },
                rawHex: '0102',
                decodedData: { portnum: 'POSITION_APP', channel_name: 'MediumFast' },
                payloadObj: { latitude_i: 250330000, longitude_i: 1215654000 },
                packetLat: 25.033,
                packetLng: 121.5654,
                positionData: { lat: 25.033, lng: 121.5654 }
            });
            executePacketTransactionPlan(posPlan, hooks);

            // Step 2: 未知節點接著收到 TELEMETRY_APP (僅含電池與電壓，不含溫溼度)
            const telePlan1 = buildMqttPacketTransactionPlan({
                fromId: unknownNodeId,
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 502, hop_limit: 2, hop_start: 3, rx_snr: 10.5, rx_rssi: -74 },
                rawHex: '0304',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: 92 } },
                telemetryData: {
                    batteryLevel: 92,
                    finalVoltage: 4.15,
                    finalCurrent: 110,
                    temperature: null,
                    humidity: null,
                    channelUtilization: 8.2,
                    airUtilTx: 1.1,
                    adcVoltage: 4.14
                }
            });
            executePacketTransactionPlan(telePlan1, hooks);

            // Step 3: 未知節點接著收到第二筆 TELEMETRY_APP (僅含環境溫溼度，電池為 null -> 測試 COALESCE 不覆寫既有電池)
            const telePlan2 = buildMqttPacketTransactionPlan({
                fromId: unknownNodeId,
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 503, hop_limit: 2, hop_start: 3, rx_snr: 10.0, rx_rssi: -75 },
                rawHex: '0506',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { environment_metrics: { temperature: 23.8, relative_humidity: 68.5 } },
                telemetryData: {
                    batteryLevel: null,
                    finalVoltage: null,
                    finalCurrent: null,
                    temperature: 23.8,
                    humidity: 68.5,
                    channelUtilization: null,
                    airUtilTx: null,
                    adcVoltage: null
                }
            });
            executePacketTransactionPlan(telePlan2, hooks);

            // Step 4: 最後才收到 NODEINFO_APP -> 驗證長短名稱更新且不洗掉先前寫入的座標與遙測數值
            const nodeInfoPlan = buildMqttPacketTransactionPlan({
                fromId: unknownNodeId,
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 504, hop_limit: 3, hop_start: 3, rx_snr: 12.0, rx_rssi: -65 },
                rawHex: '0708',
                decodedData: { portnum: 'NODEINFO_APP', channel_name: 'MediumFast' },
                payloadObj: { long_name: 'Late NodeInfo Station', short_name: 'LATE', role: 'ROUTER_CLIENT' },
                nodeInfoData: {
                    long_name: 'Late NodeInfo Station',
                    short_name: 'LATE',
                    role: 'ROUTER_CLIENT',
                    hw_model: 'HELTEC_V3',
                    firmware_version: '2.5.15',
                    firmware_build_num: '99887'
                }
            });
            executePacketTransactionPlan(nodeInfoPlan, hooks);

            // Step 5: RF Tunnel 位置封包寫入同一節點
            const rfEmits = [];
            const rfPlan = buildRfTunnelPacketTransactionPlan({
                fromId: unknownNodeId,
                gatewayId: 'RELAY_HUALIEN',
                snr: 7.5,
                rssi: -88,
                lat: 23.9769,
                lng: 121.6044,
                hopsAway: 1,
                sourceName: 'hualien',
                sourceLabel: '花蓮站',
                packetData: { from: unknownNodeId, portnum: 'POSITION', source: 'hualien' }
            });
            executePacketTransactionPlan(rfPlan, {
                enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                batchEmit: (t, p) => rfEmits.push({ t, p })
            });

            await db.flushDbQueue();

            const finalNode = await db.get('SELECT * FROM nodes WHERE node_id = ?', [unknownNodeId]);
            assert.ok(finalNode, '未知節點紀錄必須存在');
            assert.equal(finalNode.long_name, 'Late NodeInfo Station');
            assert.equal(finalNode.short_name, 'LATE');
            assert.equal(finalNode.role, 'ROUTER_CLIENT');
            assert.equal(finalNode.hw_model, 'HELTEC_V3');
            assert.equal(finalNode.latitude, 25.033);
            assert.equal(finalNode.longitude, 121.5654);
            assert.equal(finalNode.battery_level, 92, 'COALESCE 必須保留第一筆遙測的電池電量');
            assert.equal(finalNode.voltage, 4.15, 'COALESCE 必須保留第一筆遙測的電壓');
            assert.equal(finalNode.temperature, 23.8, '第二筆遙測的溫度必須成功合併');
            assert.equal(finalNode.humidity, 68.5, '第二筆遙測的濕度必須成功合併');
            assert.equal(finalNode.last_gateway, '隧道:花蓮站', 'RF Tunnel 位置封包應更新 last_gateway');
            assert.equal(rfEmits.length, 1, 'RF Tunnel 封包 COMMIT 後應觸發 raw_packet 推播');
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 二、TURSO_URL 與備份排程策略確認測試
    // =========================================================================

    it('Test 4.0.2-Policy — Backup Schedule & TURSO_URL Policy Verification: 驗證備份排程 shouldRun 守門條件與設定檔差異維持凍結政策', async () => {
        const dbPath = createTempPath('policy_check');
        const backupDir = createTempPath('policy_backups', '');
        fs.mkdirSync(backupDir, { recursive: true });

        const db = await createDatabaseSubsystem({ dbPath, backupDir, bootstrapSchema: true });
        try {
            // 1. 確認 sqlite.config.js 的預設 cronSchedule 與 index.js 的 '0 0 * * 0' 差異維持既有狀態（未擅自合併修改）
            assert.equal(sqliteConfig.backup.cronSchedule, '0 4 * * *', 'sqlite.config.js 預設 cronSchedule 應維持 0 4 * * *');

            // 2. 驗證 index.js 使用的 shouldRun 規則：未設定 BACKUP_PATH 時回傳 false，設定後且 isBootstrapReady() 為 true 時回傳 true
            let registeredCronExpr = null;
            let registeredOptions = null;
            const fakeCron = {
                validate: (expr) => expr === '0 0 * * 0',
                schedule: (expr, fn) => {
                    registeredCronExpr = expr;
                    return { stop: () => {} };
                }
            };

            const origBackupPath = process.env.BACKUP_PATH;
            try {
                delete process.env.BACKUP_PATH;
                const shouldRunFn = () => {
                    const googleDrivePath = process.env.BACKUP_PATH;
                    if (!googleDrivePath) return false;
                    if (typeof db.isBootstrapReady === 'function' && !db.isBootstrapReady()) return false;
                    return true;
                };

                db.backupManager.startSchedule('0 0 * * 0', fakeCron, { shouldRun: shouldRunFn });
                assert.equal(registeredCronExpr, '0 0 * * 0');
                assert.equal(shouldRunFn(), false, '未設定 BACKUP_PATH 時，排程備份條件必須為 false');

                process.env.BACKUP_PATH = backupDir;
                assert.equal(shouldRunFn(), true, '已設定 BACKUP_PATH 且 Schema Initialization Barrier 完成時，排程備份條件為 true');
            } finally {
                if (origBackupPath === undefined) delete process.env.BACKUP_PATH;
                else process.env.BACKUP_PATH = origBackupPath;
                db.backupManager.stopSchedule();
            }
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
            cleanupDirRecursive(backupDir);
        }
    });

    // =========================================================================
    // 三、3.1 Cross-Process Abnormal Termination (SIGKILL) & WAL Recovery 測試
    // =========================================================================

    it('Test 4.0.2-SIGKILL — Cross-Process Abnormal Termination & Recovery: 驗證交易前、交易中段未提交、COMMIT 後立即遭遇跨行程 SIGKILL 之 WAL 恢復與零殘留保證', async () => {
        const dbPath = createTempPath('cross_proc_sigkill');
        const workerScript = path.join(__dirname, 'helpers', 'sigkill_tx_worker.js');

        // 先透過主子系統完成 Temporary SQLite DB 的完整 Schema Bootstrap，再關閉連線交給子行程操作
        const initDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });
        await initDb.close();

        function runWorkerAndSigkillAtGate(mode, nodeId, expectedStage) {
            return new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [workerScript, mode, dbPath, nodeId], {
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                });

                let stageReached = false;
                let stdoutBuf = '';

                const onStageReady = () => {
                    if (stageReached) return;
                    stageReached = true;
                    // 在收到子行程抵達指定交易階段訊號後，立即發送 SIGKILL 強制終止子行程
                    child.kill('SIGKILL');
                };

                child.on('message', (msg) => {
                    if (msg && msg.stage === expectedStage) {
                        onStageReady();
                    }
                });

                child.stdout.on('data', (chunk) => {
                    stdoutBuf += chunk.toString('utf8');
                    if (stdoutBuf.includes(`"stage":"${expectedStage}"`)) {
                        onStageReady();
                    }
                });

                child.on('error', reject);
                child.on('exit', (code, signal) => {
                    if (!stageReached) {
                        return reject(new Error(`Worker (${mode}) exited before reaching ${expectedStage} (code=${code}, signal=${signal}, stdout=${stdoutBuf})`));
                    }
                    resolve({ code, signal });
                });
            });
        }

        try {
            // 1. 子行程 A：完成封包交易 COMMIT 後立即遭遇 SIGKILL (Survivor Node: !aaaa0001)
            await runWorkerAndSigkillAtGate('AFTER_COMMIT', '!aaaa0001', 'READY_FOR_SIGKILL_AFTER_COMMIT');

            // 2. 子行程 B：交易開始前遭遇 SIGKILL
            await runWorkerAndSigkillAtGate('BEFORE_TX', '!00000000', 'READY_FOR_SIGKILL_BEFORE_TX');

            // 3. 子行程 C：在 BEGIN IMMEDIATE 交易中段（已寫入 nodes, packet_logs, chat_messages, neighbors 四張表，尚未寫入 telemetry_data 且尚未 COMMIT）遭遇 SIGKILL (Ghost Node: !bbbb0002)
            await runWorkerAndSigkillAtGate('MID_TX_UNCOMMITTED', '!bbbb0002', 'READY_FOR_SIGKILL_MID_TX');

            // 4. 重新啟動資料庫子系統連接該 Temporary SQLite DB，觸發 SQLite WAL 自動回滾與恢復
            const recoveredDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });
            try {
                // 5. 驗證 PRAGMA integrity_check === 'ok'
                const integrityRow = await recoveredDb.get('PRAGMA integrity_check');
                assert.equal(integrityRow.integrity_check, 'ok', '跨行程 SIGKILL 重啟後 PRAGMA integrity_check 必須為 ok');

                // 6. 驗證已 COMMIT 的封包資料 (!aaaa0001) 完整存在於所有關聯表
                const survivorNode = await recoveredDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!aaaa0001']);
                const survivorLogs = await recoveredDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!aaaa0001']);
                const survivorTele = await recoveredDb.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!aaaa0001']);
                assert.ok(survivorNode, 'COMMIT 後遭遇 SIGKILL 的節點 !aaaa0001 必須完整保留');
                assert.equal(survivorNode.short_name, 'SURV');
                assert.equal(survivorLogs.length, 1, 'COMMIT 後遭遇 SIGKILL 的 packet_logs 必須完整保留');
                assert.equal(survivorTele.length, 1, 'COMMIT 後遭遇 SIGKILL 的 telemetry_data 必須完整保留');

                // 7. 驗證交易中段未 COMMIT 即遭遇 SIGKILL 的封包 (!bbbb0002) 在所有關聯表均零殘留
                const ghostNode = await recoveredDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!bbbb0002']);
                const ghostLogs = await recoveredDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!bbbb0002']);
                const ghostChat = await recoveredDb.all('SELECT * FROM chat_messages WHERE node_id = ?', ['!bbbb0002']);
                const ghostNb = await recoveredDb.all('SELECT * FROM neighbors WHERE node_id = ?', ['!bbbb0002']);
                const ghostTele = await recoveredDb.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!bbbb0002']);

                assert.equal(ghostNode, null, 'MID_TX SIGKILL 未提交的 nodes 寫入必須被 WAL 完全回滾');
                assert.equal(ghostLogs.length, 0, 'MID_TX SIGKILL 未提交的 packet_logs 寫入必須被 WAL 完全回滾');
                assert.equal(ghostChat.length, 0, 'MID_TX SIGKILL 未提交的 chat_messages 寫入必須被 WAL 完全回滾');
                assert.equal(ghostNb.length, 0, 'MID_TX SIGKILL 未提交的 neighbors 寫入必須被 WAL 完全回滾');
                assert.equal(ghostTele.length, 0, 'MID_TX SIGKILL 未提交的 telemetry_data 必須為 0');

                // 8. 驗證恢復後的資料庫可繼續正常讀寫與提交新封包交易
                const postRecoveryPlan = buildMqttPacketTransactionPlan({
                    fromId: '!cccc0003',
                    topic: 'msh/TW/2/e/MediumFast/!gw01',
                    resolvedChannel: 'MediumFast',
                    gatewayId: '!gw01',
                    packet: { id: 901, hop_limit: 3, hop_start: 3, rx_snr: 9.0, rx_rssi: -70 },
                    rawHex: '99887766',
                    decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                    payloadObj: { text: 'Post-SIGKILL recovery write OK', channel_name: 'MediumFast' }
                });
                executePacketTransactionPlan(postRecoveryPlan, {
                    enqueuePacketTransaction: recoveredDb.queuePacketTransaction.bind(recoveredDb),
                    batchEmit: () => {},
                    recordLivePacketAnalytics: () => {},
                    logger: { log: () => {}, error: () => {} }
                });
                await recoveredDb.flushDbQueue();

                const newMsg = await recoveredDb.get('SELECT * FROM chat_messages WHERE node_id = ?', ['!cccc0003']);
                assert.ok(newMsg, '恢復後寫入的新封包必須成功提交並可讀取');
                assert.equal(newMsg.message, 'Post-SIGKILL recovery write OK');
            } finally {
                await recoveredDb.close();
            }
        } finally {
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 四、3.2 Full index.js Startup, Real MQTT Ingestion & Shutdown Integration 測試
    // =========================================================================

    it('Test 4.0.2-IndexStartup-Success — Full index.js Startup, Real MQTT Protobuf Ingestion & Graceful Shutdown: 完整啟動受控 index.js 子行程，驗證啟動屏障順序、真實 Protobuf 封包寫入與安全關機流程', async () => {
        const dbPath = createTempPath('index_full_startup');
        const eventLogPath = createTempPath('index_events', '.json');
        const mockBroker = await startLocalMockMqttBroker();
        const httpPort = await getFreeTcpPort();
        const appEntryPath = path.resolve(__dirname, '..', '..', 'index.js');

        // 載入真實 Protobuf 定義以編碼 ServiceEnvelope 測試封包
        const protoRoot = new protobuf.Root();
        protoRoot.resolvePath = (origin, target) => path.resolve(__dirname, '..', '..', 'protobufs', target);
        await protoRoot.load([
            'meshtastic/mqtt.proto',
            'meshtastic/telemetry.proto',
            'meshtastic/portnums.proto',
            'meshtastic/mesh.proto',
            'meshtastic/channel.proto',
            'meshtastic/config.proto'
        ], { keepCase: true });
        const ServiceEnvelope = protoRoot.lookupType('meshtastic.ServiceEnvelope');
        const User = protoRoot.lookupType('meshtastic.User');

        let child = null;
        try {
            let stdoutLog = '';
            let stderrLog = '';

            let bootstrapLoggedAt = null;
            let httpListenLoggedAt = null;
            let mqttReadyLoggedAt = null;
            let seqCounter = 0;

            let resolveServerReady;
            let resolveMqttReady;
            let startupTimer;
            const serverReadyPromise = new Promise((resolve, reject) => {
                resolveServerReady = () => {
                    clearTimeout(startupTimer);
                    resolve();
                };
                startupTimer = setTimeout(() => reject(new Error(`index.js startup timeout. stdout:\n${stdoutLog}\nstderr:\n${stderrLog}`)), 4000);
            });
            let mqttTimer;
            const mqttReadyPromise = new Promise((resolve, reject) => {
                resolveMqttReady = () => {
                    clearTimeout(mqttTimer);
                    resolve();
                };
                mqttTimer = setTimeout(() => reject(new Error(`index.js MQTT client init timeout. stdout:\n${stdoutLog}\nstderr:\n${stderrLog}`)), 4000);
            });

            child = spawn(process.execPath, [appEntryPath], {
                cwd: path.resolve(__dirname, '..', '..'),
                env: {
                    ...process.env,
                    PORT: String(httpPort),
                    DB_PATH: dbPath,
                    EVENT_LOG_PATH: eventLogPath,
                    BACKUP_PATH: '',
                    TURSO_URL: '',
                    DISABLE_RF_TUNNEL: 'true',
                    CWA_API_KEY: '',
                    MQTT_BROKER: mockBroker.url,
                    MQTT_USER: 'test_user',
                    MQTT_PASSWORD: 'test_password',
                    MQTT_TOPICS: 'msh/TW/#'
                },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });

            child.stdout.on('data', (chunk) => {
                const text = chunk.toString('utf8');
                stdoutLog += text;
                for (const line of text.split(/\r?\n/)) {
                    if (line.includes('[BOOTSTRAP] 資料庫子系統初始化、PRAGMA 驗證與 Schema Initialization Barrier 全數完成') && bootstrapLoggedAt === null) {
                        bootstrapLoggedAt = ++seqCounter;
                    }
                    if (line.includes(`🚀 API 伺服器已啟動: http://localhost:${httpPort}`) && httpListenLoggedAt === null) {
                        httpListenLoggedAt = ++seqCounter;
                        resolveServerReady();
                    }
                    if (line.includes('📚 Protobuf 字典載入完成！準備啟動雷達...') && mqttReadyLoggedAt === null) {
                        mqttReadyLoggedAt = ++seqCounter;
                        resolveMqttReady();
                    }
                }
            });

            child.stderr.on('data', (chunk) => {
                stderrLog += chunk.toString('utf8');
            });

            // 等待 HTTP Server 啟動與 MQTT Client 監聽器掛載完成
            await Promise.all([
                serverReadyPromise,
                mqttReadyPromise
            ]);

            // 1. 驗證 Database Bootstrap Barrier 必須先於 HTTP 服務啟動
            assert.ok(bootstrapLoggedAt !== null, '必須輸出 [BOOTSTRAP] 完成日誌');
            assert.ok(httpListenLoggedAt !== null, '必須輸出 HTTP 伺服器啟動日誌');
            assert.ok(bootstrapLoggedAt < httpListenLoggedAt, 'Database Schema Bootstrap 必須在 HTTP 伺服器開啟通訊埠之前完成');

            // 2. 編碼一筆真實的 Protobuf NODEINFO_APP ServiceEnvelope 並注入 index.js 的 mqttClient message 管線
            const userPayload = User.encode(User.create({
                id: '!abcd1234',
                long_name: 'FullStartupNode',
                short_name: 'FSN1',
                hw_model: 4,
                role: 0
            })).finish();

            const envelopeBytes = ServiceEnvelope.encode(ServiceEnvelope.create({
                channel_id: 'MediumFast',
                gateway_id: '!gw_test',
                packet: {
                    from: 0xabcd1234,
                    to: 0xffffffff,
                    id: 777888,
                    rx_snr: 9.25,
                    rx_rssi: -71,
                    hop_limit: 3,
                    hop_start: 3,
                    decoded: {
                        portnum: 4, // NODEINFO_APP
                        payload: userPayload
                    }
                }
            })).finish();

            let flushTimer;
            const packetFlushedPromise = new Promise((resolve, reject) => {
                flushTimer = setTimeout(() => reject(new Error(`MQTT packet flush timeout. stdout:\n${stdoutLog}`)), 3000);
                child.on('message', (msg) => {
                    if (msg && msg.type === 'TEST_MQTT_PACKET_FLUSHED' && msg.requestId === 'req_nodeinfo_1') {
                        clearTimeout(flushTimer);
                        if (!msg.ok) return reject(new Error(msg.error || 'Flush failed'));
                        resolve(msg);
                    }
                });
            });

            child.send({
                type: 'TEST_INJECT_MQTT_PACKET',
                requestId: 'req_nodeinfo_1',
                topic: 'msh/TW/2/e/MediumFast/!gw_test',
                payloadHex: Buffer.from(envelopeBytes).toString('hex')
            });

            await packetFlushedPromise;

            // 3. 觸發正常 Shutdown（透過 IPC 傳送 'shutdown' 訊息，與 PM2 / graceful shutdown 一致）
            let exitTimer;
            const exitPromise = new Promise((resolve, reject) => {
                exitTimer = setTimeout(() => reject(new Error(`Shutdown exit timeout. stdout:\n${stdoutLog}\nstderr:\n${stderrLog}`)), 5000);
                child.once('exit', (code, signal) => {
                    clearTimeout(exitTimer);
                    resolve({ code, signal });
                });
            });
            child.send('shutdown');

            const exitResult = await exitPromise;
            assert.equal(exitResult.code, 0, `index.js 正常關閉應以 exit code 0 結束 (stdout:\n${stdoutLog}\nstderr:\n${stderrLog})`);
            assert.match(stdoutLog, /\[SHUTDOWN\] 隊列資料已全數安全寫入並排空/);
            assert.match(stdoutLog, /\[SHUTDOWN\] WAL 檔案已安全截斷並回寫主資料庫/);
            assert.match(stdoutLog, /\[SHUTDOWN\] SQLite 連線已安全關閉/);
            child = null;

            // 4. 重新開啟 Temporary SQLite DB 驗證 index.js 寫入並完成 TRUNCATE Checkpoint 的封包與節點紀錄
            const verifyDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: false });
            try {
                const nodeRow = await verifyDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!abcd1234']);
                assert.ok(nodeRow, 'index.js 應將真實 Protobuf NODEINFO 封包原子寫入 nodes 表');
                assert.equal(nodeRow.long_name, 'FullStartupNode');
                assert.equal(nodeRow.short_name, 'FSN1');

                const logRows = await verifyDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!abcd1234']);
                assert.equal(logRows.length, 1, 'index.js 應在同一交易將封包寫入 packet_logs 表');
                assert.equal(logRows[0].gateway_id, '!gw_test');
            } finally {
                await verifyDb.close();
            }
        } finally {
            if (child && !child.killed) {
                try { child.kill('SIGKILL'); } catch (_) {}
            }
            await mockBroker.close();
            cleanupDbFiles(dbPath);
            cleanupDbFiles(eventLogPath);
        }
    });

    it('Test 4.0.2-IndexStartup-BootstrapFailure — Schema Bootstrap Failure Blocks Service Startup: 當 Schema Index 驗證失敗時，index.js 不會提前啟動 HTTP 或 MQTT 服務並以非 0 狀態碼退出', async () => {
        const dbPath = createTempPath('index_boot_fail');
        const eventLogPath = createTempPath('index_fail_events', '.json');
        const mockBroker = await startLocalMockMqttBroker();
        const httpPort = await getFreeTcpPort();
        const appEntryPath = path.resolve(__dirname, '..', '..', 'index.js');

        // 先建立一個帶有錯誤同名索引定義 (idx_packet_logs_timestamp 建立在錯誤欄位 node_id 上) 的 Temporary DB
        const prepDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });
        await prepDb.run('DROP INDEX idx_packet_logs_timestamp');
        await prepDb.run('CREATE INDEX idx_packet_logs_timestamp ON packet_logs(node_id)');
        await prepDb.close();

        let child = null;
        try {
            let stdoutLog = '';
            let stderrLog = '';

            child = spawn(process.execPath, [appEntryPath], {
                cwd: path.resolve(__dirname, '..', '..'),
                env: {
                    ...process.env,
                    PORT: String(httpPort),
                    DB_PATH: dbPath,
                    EVENT_LOG_PATH: eventLogPath,
                    BACKUP_PATH: '',
                    TURSO_URL: '',
                    DISABLE_RF_TUNNEL: 'true',
                    CWA_API_KEY: '',
                    MQTT_BROKER: mockBroker.url,
                    MQTT_USER: 'test_user',
                    MQTT_PASSWORD: 'test_password'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            child.stdout.on('data', (d) => { stdoutLog += d.toString('utf8'); });
            child.stderr.on('data', (d) => { stderrLog += d.toString('utf8'); });

            const exitResult = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Child process did not exit on fatal bootstrap error')), 6000);
                child.once('exit', (code, signal) => {
                    clearTimeout(timer);
                    resolve({ code, signal });
                });
            });

            assert.equal(exitResult.code, 1, 'Schema Bootstrap 失敗時，index.js 必須以非 0 狀態碼 (1) 終止');
            assert.match(stderrLog, /\[FATAL_BOOTSTRAP_ERROR\]/, '必須記錄 [FATAL_BOOTSTRAP_ERROR]');
            assert.ok(!stdoutLog.includes('🚀 API 伺服器已啟動'), 'Schema Bootstrap 失敗時，絕不可啟動 HTTP API 伺服器');
            assert.ok(!stdoutLog.includes('✅ 已成功連線到 MQTT 伺服器！'), 'Schema Bootstrap 失敗時，絕不可啟動 MQTT 連線');
            child = null;
        } finally {
            if (child && !child.killed) {
                try { child.kill('SIGKILL'); } catch (_) {}
            }
            await mockBroker.close();
            cleanupDbFiles(dbPath);
            cleanupDbFiles(eventLogPath);
        }
    });
});
