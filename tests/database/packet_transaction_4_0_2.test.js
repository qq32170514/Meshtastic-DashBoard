// tests/database/packet_transaction_4_0_2.test.js
// Meshtastic-DashBoard 4.0.2 — Packet Transaction Boundary, Error Classification, Turso Fallback & Cross-Process Integration Suite
// 嚴格遵守開發環境隔離：所有測試僅在 os.tmpdir() 建立與銷毀獨立 Temporary SQLite DB、臨時通訊端點與子行程，絕不接觸正式環境。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');
const protobuf = require('protobufjs');

const {
    createDatabaseSubsystem,
    buildMqttPacketTransactionPlan,
    buildRfTunnelPacketTransactionPlan,
    executePacketTransactionPlan,
    executeSequentialFallbackItem,
    createTursoDbWrapper,
    createSequentialFallbackQueueController,
    APP_BACKUP_CRON_EXPRESSION,
    createAppBackupSchedulePolicy,
    registerAppBackupSchedule,
    QUEUE_STATES,
    ITEM_STATUS
} = require('../../src/database');
const { ERROR_TYPES, classifyError } = require('../../src/database/retry-policy');
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
 * 建立輕量級原生 MQTT (v3.1.1 / v5.0) Wire-Level 測試 Broker
 * 支援 CONNECT -> CONNACK、SUBSCRIBE -> SUBACK、PINGREQ -> PINGRESP 與主動發送 Wire-Level PUBLISH (0x30) 二進位封包。
 * 在 Windows 環境支援 Named Pipe (\\.\pipe\...) 以避免沙盒阻擋 TCP Loopback，在 POSIX 支援 Unix Socket 或 127.0.0.1 TCP。
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
    const propsBuf = protocolVersion === 5 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const body = Buffer.concat([topicLenBuf, topicBuf, propsBuf, payloadBuffer]);
    const fixedHeader = Buffer.from([0x30]); // PUBLISH QoS 0
    const remLen = encodeMqttRemainingLength(body.length);
    return Buffer.concat([fixedHeader, remLen, body]);
}

function startLocalMockMqttBroker(options = {}) {
    const usePipe = options.usePipe !== undefined ? options.usePipe : (process.platform === 'win32');
    const maxRemainingLength = typeof options.maxRemainingLength === 'number' && options.maxRemainingLength > 0
        ? options.maxRemainingLength
        : 256 * 1024; // 預設單封包最大 Remaining Length 256KB
    const maxBufferSize = typeof options.maxBufferSize === 'number' && options.maxBufferSize > 0
        ? options.maxBufferSize
        : maxRemainingLength + 1024;

    const pipePath = usePipe
        ? (process.platform === 'win32'
            ? `\\\\.\\pipe\\mesh_mqtt_broker_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            : createTempPath('mesh_mqtt_broker', '.sock'))
        : null;

    const sockets = new Set();
    const socketStates = new Map();
    const receivedPublishes = [];
    const protocolErrors = [];
    const publishWaiters = [];
    let nextSocketId = 1;
    let clientProtocolVersion = 4;
    let subscribedResolve = null;
    const subscribedPromise = new Promise((resolve) => {
        subscribedResolve = resolve;
    });

    function notifyPublishWaiters() {
        for (let i = publishWaiters.length - 1; i >= 0; i--) {
            const waiter = publishWaiters[i];
            if (receivedPublishes.length >= waiter.targetCount) {
                publishWaiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(receivedPublishes.slice());
            }
        }
    }

    function recordProtocolError(socket, state, reason, details = {}) {
        const errEntry = {
            socketId: state ? state.socketId : null,
            reason,
            ...details
        };
        protocolErrors.push(errEntry);
        if (state) {
            state.receiveBuffer = Buffer.alloc(0);
            state.aborted = true;
        }
        try {
            socket.destroy();
        } catch (_) {}
    }

    /**
     * 解析單一完整 MQTT PUBLISH 封包內容 (支援 QoS 0/1/2 與 MQTT v3.1.1 / v5.0)
     */
    function parseMqttPublishBody(firstByte, bodyBuf, protoVer, socketId) {
        if (bodyBuf.length < 2) {
            return { error: 'PUBLISH_BODY_TOO_SHORT_FOR_TOPIC_LEN' };
        }
        const qos = (firstByte & 0x06) >> 1;
        const topicLen = bodyBuf.readUInt16BE(0);
        let cursor = 2;
        if (bodyBuf.length < cursor + topicLen) {
            return { error: 'PUBLISH_BODY_TOO_SHORT_FOR_TOPIC' };
        }
        const topic = bodyBuf.subarray(cursor, cursor + topicLen).toString('utf8');
        cursor += topicLen;

        let packetId = null;
        if (qos > 0) {
            if (bodyBuf.length < cursor + 2) {
                return { error: 'PUBLISH_BODY_TOO_SHORT_FOR_PACKET_ID' };
            }
            packetId = bodyBuf.readUInt16BE(cursor);
            cursor += 2;
        }

        if (protoVer === 5) {
            // 解碼 MQTT v5 Properties Length (Variable Byte Integer)
            let propMult = 1;
            let propLen = 0;
            let propByte = 0;
            let propBytesRead = 0;
            do {
                if (cursor >= bodyBuf.length) {
                    return { error: 'PUBLISH_V5_PROPS_INCOMPLETE' };
                }
                propByte = bodyBuf[cursor++];
                propBytesRead++;
                if (propBytesRead > 4) {
                    return { error: 'PUBLISH_V5_PROPS_MALFORMED' };
                }
                propLen += (propByte & 0x7f) * propMult;
                propMult *= 128;
            } while ((propByte & 0x80) !== 0);

            if (bodyBuf.length < cursor + propLen) {
                return { error: 'PUBLISH_V5_PROPS_OVERFLOW' };
            }
            cursor += propLen;
        }

        const payload = Buffer.from(bodyBuf.subarray(cursor));
        return {
            topic,
            payload,
            qos,
            packetId,
            socketId
        };
    }

    const server = net.createServer((socket) => {
        const state = {
            socketId: nextSocketId++,
            protocolVersion: 4,
            receiveBuffer: Buffer.alloc(0),
            aborted: false
        };
        sockets.add(socket);
        socketStates.set(socket, state);

        const cleanupSocketState = () => {
            state.receiveBuffer = Buffer.alloc(0);
            socketStates.delete(socket);
            sockets.delete(socket);
        };

        socket.on('close', cleanupSocketState);
        socket.on('error', () => {});

        socket.on('data', (chunk) => {
            if (state.aborted || !chunk || chunk.length === 0) return;

            // 10. 防止惡意或異常不完整封包造成無上限緩衝增長
            if (state.receiveBuffer.length + chunk.length > maxBufferSize) {
                recordProtocolError(socket, state, 'MAX_BUFFER_SIZE_EXCEEDED', {
                    bufferedBytes: state.receiveBuffer.length,
                    incomingBytes: chunk.length,
                    maxBufferSize
                });
                return;
            }

            // 1. 將新收到的 chunk 附加至該 Socket 專屬之 receiveBuffer
            state.receiveBuffer = state.receiveBuffer.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([state.receiveBuffer, chunk]);

            let offset = 0;
            const buf = state.receiveBuffer;

            while (offset < buf.length) {
                // 2. 至少需要 2 bytes (1 byte Fixed Header type/flags + 至少 1 byte Remaining Length)
                if (buf.length - offset < 2) {
                    break;
                }

                const firstByte = buf[offset];
                const packetType = firstByte & 0xf0;

                // 3. 解析 MQTT Variable-Byte Remaining Length (最多 4 bytes)
                let multiplier = 1;
                let remLen = 0;
                let idx = offset + 1;
                let encodedByte = 0;
                let remLenByteCount = 0;
                let remLenComplete = false;

                while (idx < buf.length) {
                    encodedByte = buf[idx++];
                    remLenByteCount++;

                    if (remLenByteCount > 4) {
                        recordProtocolError(socket, state, 'MALFORMED_REMAINING_LENGTH_VARINT', {
                            remLenByteCount
                        });
                        return;
                    }

                    remLen += (encodedByte & 0x7f) * multiplier;
                    if (remLen > maxRemainingLength) {
                        recordProtocolError(socket, state, 'REMAINING_LENGTH_EXCEEDS_LIMIT', {
                            remLen,
                            maxRemainingLength
                        });
                        return;
                    }

                    if ((encodedByte & 0x80) === 0) {
                        remLenComplete = true;
                        break;
                    }

                    if (remLenByteCount === 4 && (encodedByte & 0x80) !== 0) {
                        recordProtocolError(socket, state, 'MALFORMED_REMAINING_LENGTH_VARINT', {
                            remLenByteCount: 5
                        });
                        return;
                    }

                    multiplier *= 128;
                }

                // 若 Remaining Length 本身尚未收齊 (被拆成多個 chunks)，保留剩餘資料等待下一次 data 事件
                if (!remLenComplete) {
                    break;
                }

                const packetEnd = idx + remLen;
                if (packetEnd - offset > maxBufferSize) {
                    recordProtocolError(socket, state, 'PACKET_TOTAL_SIZE_EXCEEDS_LIMIT', {
                        packetSize: packetEnd - offset,
                        maxBufferSize
                    });
                    return;
                }

                // 4 & 5. 若完整封包 Payload 尚未全部到達，保留剩餘資料等待下一次 data 事件
                if (packetEnd > buf.length) {
                    break;
                }

                // 擷取完整封包 Body
                const bodySlice = buf.subarray(idx, packetEnd);

                if (packetType === 0x10) {
                    // CONNECT
                    if (bodySlice.length < 4) {
                        recordProtocolError(socket, state, 'MALFORMED_CONNECT_PACKET');
                        return;
                    }
                    const protoNameLen = bodySlice.readUInt16BE(0);
                    if (bodySlice.length < 2 + protoNameLen + 1) {
                        recordProtocolError(socket, state, 'MALFORMED_CONNECT_PROTO_LEVEL');
                        return;
                    }
                    const protoLevel = bodySlice[2 + protoNameLen];
                    state.protocolVersion = protoLevel === 5 ? 5 : 4;
                    clientProtocolVersion = state.protocolVersion;
                    if (state.protocolVersion === 5) {
                        socket.write(Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]));
                    } else {
                        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
                    }
                } else if (packetType === 0x30) {
                    // PUBLISH
                    const parsedPub = parseMqttPublishBody(firstByte, bodySlice, state.protocolVersion, state.socketId);
                    if (parsedPub.error) {
                        recordProtocolError(socket, state, parsedPub.error);
                        return;
                    }
                    receivedPublishes.push(parsedPub);
                    if (parsedPub.qos === 1 && parsedPub.packetId !== null) {
                        const pubAck = Buffer.alloc(4);
                        pubAck[0] = 0x40;
                        pubAck[1] = 0x02;
                        pubAck.writeUInt16BE(parsedPub.packetId, 2);
                        socket.write(pubAck);
                    }
                    // 轉發給其他已連線的訂閱端
                    const forwardPkt = buildMqttPublishPacket(parsedPub.topic, parsedPub.payload, clientProtocolVersion);
                    for (const s of sockets) {
                        if (s !== socket && !s.destroyed) {
                            s.write(forwardPkt);
                        }
                    }
                    notifyPublishWaiters();
                } else if (packetType === 0x80) {
                    // SUBSCRIBE
                    const pktIdHi = bodySlice[0] || 0;
                    const pktIdLo = bodySlice[1] || 1;
                    if (state.protocolVersion === 5) {
                        socket.write(Buffer.from([0x90, 0x04, pktIdHi, pktIdLo, 0x00, 0x00]));
                    } else {
                        socket.write(Buffer.from([0x90, 0x03, pktIdHi, pktIdLo, 0x00]));
                    }
                    if (subscribedResolve) {
                        subscribedResolve(socket);
                        subscribedResolve = null;
                    }
                } else if (packetType === 0xc0) {
                    // PINGREQ
                    socket.write(Buffer.from([0xd0, 0x00]));
                } else if (packetType === 0xe0) {
                    // DISCONNECT
                    socket.end();
                }

                offset = packetEnd;
            }

            // 移除已解析完成的封包區段，保留未完成的尾端殘留 bytes
            if (!state.aborted) {
                if (offset === buf.length) {
                    state.receiveBuffer = Buffer.alloc(0);
                } else if (offset > 0) {
                    state.receiveBuffer = Buffer.from(buf.subarray(offset));
                }
            }
        });
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        const onListening = () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 1883;
            resolve({
                port,
                pipePath,
                url: `mqtt://127.0.0.1:${port}`,
                receivedPublishes,
                protocolErrors,
                getActiveSocketCount: () => socketStates.size,
                getSocketBufferLengths: () => Array.from(socketStates.values()).map((s) => ({
                    socketId: s.socketId,
                    bufferedBytes: s.receiveBuffer.length
                })),
                waitForSubscription: () => subscribedPromise,
                waitForPublishCount: (targetCount, timeoutMs = 3000) => {
                    if (receivedPublishes.length >= targetCount) {
                        return Promise.resolve(receivedPublishes.slice());
                    }
                    return new Promise((res, rej) => {
                        const timer = setTimeout(() => {
                            rej(new Error(`Timeout waiting for ${targetCount} MQTT publishes (received=${receivedPublishes.length})`));
                        }, timeoutMs);
                        publishWaiters.push({ targetCount, resolve: res, timer });
                    });
                },
                publish(topic, payloadBuffer) {
                    const pkt = buildMqttPublishPacket(topic, payloadBuffer, clientProtocolVersion);
                    for (const s of sockets) {
                        if (!s.destroyed) s.write(pkt);
                    }
                },
                async close() {
                    for (const waiter of publishWaiters.splice(0)) {
                        clearTimeout(waiter.timer);
                    }
                    for (const s of sockets) {
                        try { s.destroy(); } catch (_) {}
                    }
                    socketStates.clear();
                    sockets.clear();
                    await new Promise((r) => server.close(() => r()));
                    if (pipePath && process.platform !== 'win32') {
                        try { if (fs.existsSync(pipePath)) fs.unlinkSync(pipePath); } catch (_) {}
                    }
                }
            });
        };

        if (pipePath) {
            server.listen(pipePath, onListening);
        } else {
            server.listen(0, '127.0.0.1', onListening);
        }
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

function querySqliteAll(dbFile, sql, params = []) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (openErr) => {
            if (openErr) return reject(openErr);
            conn.all(sql, params, (err, rows) => {
                conn.close(() => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            });
        });
    });
}

describe('Meshtastic-DashBoard 4.0.2 — Packet Transaction Boundary, Error Classification, Turso Fallback & Cross-Process Suite', () => {

    // =========================================================================
    // 1. 單一封包多資料表原子提交成功
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
            // 確認發出的事件名稱嚴格屬於專案實際定義的 node_seen / raw_packet / telemetry_update
            for (const e of emittedEvents) {
                assert.ok(['node_seen', 'raw_packet', 'telemetry_update'].includes(e.type), `未預期的事件名稱: ${e.type}`);
            }
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 2. 中間步驟 SQL 失敗與 Rollback (Section 五 #1)
    // =========================================================================
    it('Test 4.0.2-2 — Middle SQL Failure & Atomic Rollback: 4 筆語句之封包在第 3 筆 (中間步驟 index=2) 失敗時，前 2 筆完整 Rollback 且第 4 筆絕不執行', async () => {
        const dbPath = createTempPath('pkt_tx_mid_rollback');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            // TELEMETRY_APP 包含 4 筆 SQL:
            // [0] INSERT INTO nodes ... (節點發現 Upsert)
            // [1] INSERT INTO packet_logs ... (封包紀錄)
            // [2] UPDATE nodes SET battery_level = ... (中間第 3 筆語句!)
            // [3] INSERT INTO telemetry_data ... (最後第 4 筆語句)
            // 在 nodes 的 UPDATE 建立 Trigger，讓第 3 筆語句 (index=2) 觸發 SQLITE_CONSTRAINT 失敗
            await db.run(`
                CREATE TRIGGER trg_reject_middle_node_telemetry_update
                BEFORE UPDATE OF battery_level ON nodes
                WHEN NEW.battery_level < -500
                BEGIN
                    SELECT RAISE(ABORT, 'MIDDLE_STEP_3_NODE_UPDATE_CONSTRAINT_FAILED');
                END;
            `);

            const executedSqlTrace = [];
            const origTransaction = db.adapter.transaction.bind(db.adapter);
            db.adapter.transaction = async (txFn) => {
                return origTransaction(async (tx) => {
                    const wrappedTx = {
                        ...tx,
                        execute: async (sql, params) => {
                            executedSqlTrace.push(sql.trim().split(/\s+/)[0].toUpperCase() + ':' + sql.trim().slice(0, 32));
                            return tx.execute(sql, params);
                        }
                    };
                    return txFn(wrappedTx);
                });
            };

            const emittedEvents = [];
            const analyticsCalls = [];
            let callbackErr = null;

            const midFailPlan = buildMqttPacketTransactionPlan({
                fromId: '!midfail01',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 202, hop_limit: 3, hop_start: 3, rx_snr: 6.0, rx_rssi: -88 },
                rawHex: 'AA11BB22',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: -600 } },
                telemetryData: {
                    batteryLevel: -600,
                    finalVoltage: 3.85,
                    finalCurrent: 40,
                    temperature: 21.0,
                    humidity: 55.0,
                    channelUtilization: 4.0,
                    airUtilTx: 0.4,
                    adcVoltage: 3.85
                }
            });
            assert.equal(midFailPlan.statements.length, 4);

            executePacketTransactionPlan(
                midFailPlan,
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

            assert.ok(callbackErr, '中間步驟失敗時必須透過 callback 回報錯誤');
            assert.equal(callbackErr.failedStatementIndex, 2, '應明確記錄失敗發生在第 3 條 SQL (index=2)');
            assert.match(callbackErr.failedStatementSql, /^UPDATE nodes SET/i);

            // 驗證第 4 條 SQL (INSERT INTO telemetry_data) 根本沒有被繼續執行
            assert.equal(executedSqlTrace.length, 3, '只應執行到第 3 條 SQL (0, 1, 2)，第 4 條 SQL 絕不可繼續執行');
            assert.equal(
                executedSqlTrace.some((s) => s.includes('telemetry_data')),
                false,
                '第 4 條 INSERT INTO telemetry_data 絕不可被執行'
            );

            // 驗證第 1 條 (nodes) 與第 2 條 (packet_logs) 的寫入已完整 Rollback
            const ghostNode = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!midfail01']);
            const ghostLogs = await db.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!midfail01']);
            const ghostTele = await db.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!midfail01']);

            assert.equal(ghostNode, null, '前一步驟寫入的 nodes 必須被完整 Rollback');
            assert.equal(ghostLogs.length, 0, '前一步驟寫入的 packet_logs 必須被完整 Rollback');
            assert.equal(ghostTele.length, 0, '後續步驟的 telemetry_data 必須為 0 筆');

            assert.equal(emittedEvents.length, 0, '失敗交易不得觸發任何 batchEmit');
            assert.equal(analyticsCalls.length, 0, '失敗交易不得觸發任何 recordLivePacketAnalytics');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 3. 最終步驟 SQL 失敗與 Rollback
    // =========================================================================
    it('Test 4.0.2-3 — Final SQL Failure & Atomic Rollback: 4 筆語句之封包在最後一筆 (index=3) 失敗時，前面所有表寫入全數 Rollback', async () => {
        const dbPath = createTempPath('pkt_tx_final_rollback');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            await db.run(`
                CREATE TRIGGER trg_reject_final_telemetry_insert
                BEFORE INSERT ON telemetry_data
                WHEN NEW.battery_level < -900
                BEGIN
                    SELECT RAISE(ABORT, 'SIMULATED_TELEMETRY_FINAL_STEP_CONSTRAINT_FAILURE');
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
                    batteryLevel: -999,
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

            assert.ok(callbackErr, '失敗封包的回呼必須收到錯誤');
            assert.match(callbackErr.message, /QUARANTINED_CONSTRAINT_ERROR/);
            assert.equal(callbackErr.failedStatementIndex, 3, '應精確記錄失敗發生於第 4 筆 SQL (index=3)');

            const ghostNode = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!bad00001']);
            const ghostLogs = await db.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!bad00001']);
            const ghostTele = await db.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!bad00001']);

            assert.equal(ghostNode, null, '回滾後 nodes 表絕不可殘留 !bad00001 的部分寫入');
            assert.equal(ghostLogs.length, 0, '回滾後 packet_logs 表絕不可殘留 !bad00001 的部分寫入');
            assert.equal(ghostTele.length, 0, '回滾後 telemetry_data 表絕不可殘留 !bad00001 的部分寫入');

            assert.equal(emittedEvents.length, 0, '回滾封包絕不可觸發任何 WebSocket batchEmit');
            assert.equal(analyticsCalls.length, 0, '回滾封包絕不可觸發任何戰情分析累加');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 4. RF Tunnel 封包交易失敗與 Rollback (Section 五 #2)
    // =========================================================================
    it('Test 4.0.2-4 — RF Tunnel Packet Transaction Failure & Rollback: RF Tunnel 封包第 2 條 SQL 失敗時，第 1 條 packet_logs 寫入完整 Rollback 且不發送成功事件', async () => {
        const dbPath = createTempPath('pkt_tx_rf_rollback');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            // 先建立一個既有節點，確認後續 RF Tunnel 交易失敗不會污染其原本的 last_gateway
            await db.run(
                `INSERT INTO nodes (node_id, long_name, short_name, last_gateway) VALUES (?, ?, ?, ?)`,
                ['!rfnode01', 'RF Existing Node', 'RF01', '!gw_original']
            );

            // 在 nodes 的 UPDATE 建立 Trigger，模擬 RF Tunnel 交易的第 2 條 SQL (UPDATE nodes SET last_seen=..., last_gateway=?) 發生約束失敗
            await db.run(`
                CREATE TRIGGER trg_reject_rf_tunnel_node_update
                BEFORE UPDATE OF last_gateway ON nodes
                WHEN NEW.last_gateway = '隧道:故障測試站'
                BEGIN
                    SELECT RAISE(ABORT, 'RF_TUNNEL_STEP_2_NODE_UPDATE_FAILED');
                END;
            `);

            const rfEmits = [];
            let rfCallbackErr = null;
            let rfCallbackCount = 0;

            const rfPlan = buildRfTunnelPacketTransactionPlan({
                fromId: '!rfnode01',
                gatewayId: 'RELAY_FAULTY',
                snr: 5.5,
                rssi: -92,
                lat: 24.1477,
                lng: 120.6736,
                hopsAway: 2,
                sourceName: 'taichung_faulty',
                sourceLabel: '故障測試站',
                packetData: { from: '!rfnode01', portnum: 'POSITION', source: 'taichung_faulty' }
            });
            assert.equal(rfPlan.statements.length, 2, 'RF Tunnel 交易應包含 2 條 SQL');

            executePacketTransactionPlan(
                rfPlan,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    batchEmit: (type, payload) => rfEmits.push({ type, payload }),
                    logger: { log: () => {}, error: () => {} }
                },
                (err) => {
                    rfCallbackCount++;
                    rfCallbackErr = err;
                }
            );

            await db.flushDbQueue();

            assert.equal(rfCallbackCount, 1, 'RF Tunnel 失敗回呼應精確執行 1 次');
            assert.ok(rfCallbackErr, 'RF Tunnel 失敗時應收到錯誤');
            assert.equal(rfCallbackErr.failedStatementIndex, 1, '應記錄失敗發生於第 2 條 SQL (index=1)');

            // 驗證第 1 條已執行的 INSERT INTO packet_logs 被完整 Rollback
            const tunnelLogs = await db.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!rfnode01']);
            assert.equal(tunnelLogs.length, 0, 'RF Tunnel 交易 Rollback 後，packet_logs 不得殘留第 1 條 SQL 的紀錄');

            // 驗證 nodes 表維持原狀
            const nodeAfter = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!rfnode01']);
            assert.equal(nodeAfter.last_gateway, '!gw_original', 'nodes.last_gateway 不得被失敗交易修改');

            // 驗證未觸發成功事件
            assert.equal(rfEmits.length, 0, 'RF Tunnel 交易失敗時不得觸發 raw_packet 推播');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 5. P1 測試 A：DATA_CONSTRAINT 二元隔離 (Section 二 測試 A)
    // =========================================================================
    it('Test 4.0.2-5 — DATA_CONSTRAINT Binary Isolation (P1 Test A): 封包交易發生資料約束錯誤時，Binary Isolation 正常隔離壞封包且同批合法封包完整提交', async () => {
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
                executePacketTransactionPlan(plan, hooks, (err) => {
                    results.push({ nodeId, ok: !err, err });
                });
            }

            await db.flushDbQueue();

            assert.equal(results.length, 5, '5 個封包都應完成回呼');
            const goodResults = results.filter(r => r.ok).map(r => r.nodeId);
            const badResults = results.filter(r => !r.ok);

            assert.deepEqual(goodResults, ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);
            assert.equal(badResults.length, 1);
            assert.equal(badResults[0].nodeId, '!bad_pkt_3');
            assert.equal(badResults[0].err.errorType, ERROR_TYPES.DATA_CONSTRAINT);
            assert.equal(badResults[0].err.failedStatementIndex, 2, '應在封包的第 3 筆語句 (packet_logs) 觸發失敗');

            const badNodeRow = await db.get('SELECT * FROM nodes WHERE node_id = ?', ['!bad_pkt_3']);
            const badChatRows = await db.all('SELECT * FROM chat_messages WHERE node_id = ?', ['!bad_pkt_3']);
            const badLogRows = await db.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!bad_pkt_3']);
            assert.equal(badNodeRow, null, 'Binary Isolation 絕不可將失敗封包的第 1 筆 nodes 語句單獨提交');
            assert.equal(badChatRows.length, 0, 'Binary Isolation 絕不可將失敗封包的第 2 筆 chat_messages 語句單獨提交');
            assert.equal(badLogRows.length, 0, 'Binary Isolation 絕不可將失敗封包的第 3 筆 packet_logs 語句提交');

            const committedNodes = await db.all('SELECT node_id FROM nodes ORDER BY node_id ASC');
            const committedChats = await db.all('SELECT node_id, message FROM chat_messages ORDER BY node_id ASC');
            const committedLogs = await db.all('SELECT node_id FROM packet_logs ORDER BY node_id ASC');

            assert.deepEqual(committedNodes.map(r => r.node_id), ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);
            assert.deepEqual(committedChats.map(r => r.node_id), ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);
            assert.deepEqual(committedLogs.map(r => r.node_id), ['!good_pkt_1', '!good_pkt_2', '!good_pkt_4', '!good_pkt_5']);

            const qMetrics = db.writeQueue.getMetrics();
            assert.equal(db.writeQueue.state, QUEUE_STATES.NORMAL, 'DATA_CONSTRAINT 隔離後佇列應維持 NORMAL 狀態');
            assert.equal(qMetrics.totalAccepted, 5);
            assert.equal(qMetrics.totalCommitted, 4);
            assert.equal(qMetrics.totalQuarantined, 1);
            assert.equal(qMetrics.uncommittedErrorCount, 0);
            assert.equal(db.writeQueue.quarantinedItems[0].isTransactionUnit, true);
            assert.equal(db.writeQueue.quarantinedItems[0].errorType, ERROR_TYPES.DATA_CONSTRAINT);
            assert.equal(db.writeQueue.quarantinedItems[0].statements.length, 3);
            assertDataConservation(qMetrics);
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 6. P1 測試 B：UNKNOWN 錯誤嚴禁進入 Binary Isolation 並觸發 Fatal 暫停 (Section 二 測試 B)
    // =========================================================================
    it('Test 4.0.2-6 — UNKNOWN Error Fatal Pause & No Binary Isolation (P1 Test B): 封包交易發生 SQLITE_ERROR 等 UNKNOWN 錯誤時，不進入 Binary Isolation、不標記 QUARANTINED，並觸發 Fatal 暫停保護', async () => {
        const dbPath = createTempPath('pkt_tx_unknown_fatal');
        const db = await createDatabaseSubsystem({
            dbPath,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 10, flushIntervalMs: 5000 } }
        });

        try {
            let binaryIsolateCalled = false;
            const origBinaryIsolate = db.writeQueue._binaryIsolateBatch.bind(db.writeQueue);
            db.writeQueue._binaryIsolateBatch = async (...args) => {
                binaryIsolateCalled = true;
                return origBinaryIsolate(...args);
            };

            const settledCallbacks = [];
            const emits = [];
            const hooks = {
                enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                batchEmit: (type, payload) => emits.push({ type, payload }),
                recordLivePacketAnalytics: () => {},
                logger: { log: () => {}, error: () => {} }
            };

            // 封包 1：合法封包（但與封包 2 在同一個批次交易中）
            const validPlan = buildMqttPacketTransactionPlan({
                fromId: '!pkt_before_unknown',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 601, hop_limit: 3, hop_start: 3, rx_snr: 8.0, rx_rssi: -75 },
                rawHex: '0101',
                decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                payloadObj: { text: 'Valid packet in same batch', channel_name: 'MediumFast' }
            });

            // 封包 2：包含 SQLITE_ERROR (不存在的資料表 / 欄位語法錯誤 -> classifyError 判定為 ERROR_TYPES.UNKNOWN)
            const unknownErrPlan = buildMqttPacketTransactionPlan({
                fromId: '!pkt_with_unknown_err',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 602, hop_limit: 3, hop_start: 3, rx_snr: 8.0, rx_rssi: -75 },
                rawHex: '0202',
                decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                payloadObj: { text: 'Packet triggering SQLITE_ERROR', channel_name: 'MediumFast' },
                extraStatements: [
                    {
                        sql: 'INSERT INTO non_existent_table_xyz (bad_col) VALUES (?)',
                        params: ['boom']
                    }
                ]
            });

            executePacketTransactionPlan(validPlan, hooks, (err, res) => {
                settledCallbacks.push({ id: 'pkt1', err, res });
            });
            executePacketTransactionPlan(unknownErrPlan, hooks, (err, res) => {
                settledCallbacks.push({ id: 'pkt2', err, res });
            });

            await db.flushDbQueue();

            // 1. 確認該錯誤確實屬於 ERROR_TYPES.UNKNOWN
            assert.ok(db.writeQueue.lastError, 'WriteQueue 應記錄 lastError');
            assert.equal(classifyError(db.writeQueue.lastError), ERROR_TYPES.UNKNOWN);

            // 2. 確認絕對沒有進入 Binary Isolation，也沒有任何項目被標記為 QUARANTINED
            assert.equal(binaryIsolateCalled, false, 'ERROR_TYPES.UNKNOWN 絕不可進入 _binaryIsolateBatch');
            assert.equal(db.writeQueue.totalQuarantined, 0, 'UNKNOWN 錯誤不得標記為 QUARANTINED');
            assert.equal(db.writeQueue.quarantinedItems.length, 0);

            // 3. 確認 WriteQueue 已進入 PAUSED_ERROR 致命錯誤暫停狀態，且拒絕後續新寫入
            assert.equal(db.writeQueue.state, QUEUE_STATES.PAUSED_ERROR, '遇到 UNKNOWN 錯誤時 WriteQueue 必須進入 PAUSED_ERROR');
            assert.equal(db.writeQueue._shutdownGateClosed, true, '必須關閉寫入閘門防止持續寫入異常資料庫');

            let postPauseRejectErr = null;
            const acceptedAfterPause = db.queueDbOp('INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)', ['!x', 'y', 'z'], (err) => {
                postPauseRejectErr = err;
            });
            assert.equal(acceptedAfterPause, false, 'PAUSED_ERROR 狀態下必須拒絕後續新寫入');
            assert.ok(postPauseRejectErr);

            // 4. 確認尚未提交的項目全數標記為 UNCOMMITTED_ERROR，沒有任何項目被錯誤回報為成功
            assert.equal(settledCallbacks.length, 2, '批次內 2 個未提交項目皆應收到錯誤回呼');
            assert.ok(settledCallbacks[0].err, '同批次未提交之 pkt1 不得被誤判為成功');
            assert.ok(settledCallbacks[1].err, '觸發 UNKNOWN 之 pkt2 不得被誤判為成功');
            assert.equal(emits.length, 0, '交易回滾時不得發出任何 batchEmit');

            // 5. 確認保留完整診斷資訊 (failedStatementIndex, failedStatementSql, errorType, transactionLabel)
            assert.equal(db.writeQueue.uncommittedErrors.length, 2);
            const diag = db.writeQueue.uncommittedErrors[1];
            assert.equal(diag.errorType, ERROR_TYPES.UNKNOWN);
            assert.equal(diag.failedStatementIndex, 3);
            assert.match(diag.failedStatementSql, /non_existent_table_xyz/);
            assert.equal(diag.transactionLabel, 'MQTT_PACKET:!pkt_with_unknown_err:TEXT_MESSAGE_APP');

            // 6. 確認資料庫中無任何殘留寫入
            const nodesInDb = await db.all('SELECT * FROM nodes');
            assert.equal(nodesInDb.length, 0, '回滾後資料庫不得有任何部分寫入');
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 7. Post-Commit 時序與 Callback Exactly-Once 保證
    // =========================================================================
    it('Test 4.0.2-7 — Post-Commit Ordering & Exactly-Once Callback: 每個封包回呼最多只觸發一次，且未提交前絕不提前回報成功或觸發推播', async () => {
        const dbPath = createTempPath('pkt_tx_cb_order');
        const db = await createDatabaseSubsystem({
            dbPath,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 50, flushIntervalMs: 10000 } }
        });

        try {
            const timeline = [];
            let cbInvocationCount = 0;

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

    // =========================================================================
    // 8. P2：Post-Commit Hook 例外保護與 Callback 不遺失測試 (Section 四)
    // =========================================================================
    it('Test 4.0.2-8 — Post-Commit Hook Exception Isolation (P2): 分別模擬 logger、analytics、batchEmit 拋出例外，確認 SQLite 交易維持已提交、其他 hook 繼續執行且 caller callback 確保執行一次', async () => {
        const dbPath = createTempPath('pkt_tx_hook_isolation');
        const db = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });

        try {
            // Case 1: logger.log 拋出例外 -> analytics、batchEmit 與 caller callback 仍正常執行
            const case1ErrorsLogged = [];
            let case1AnalyticsCount = 0;
            const case1Emits = [];
            let case1CbCount = 0;
            let case1CbErr = 'NOT_CALLED';
            let case1CbRes = null;

            const plan1 = buildMqttPacketTransactionPlan({
                fromId: '!hook_node_1',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 701, hop_limit: 3, hop_start: 3, rx_snr: 8.0, rx_rssi: -70 },
                rawHex: 'AA01',
                decodedData: { portnum: 'NODEINFO_APP', channel_name: 'MediumFast' },
                payloadObj: { long_name: 'Hook Test 1', short_name: 'HK1', role: 'CLIENT' },
                nodeInfoData: { long_name: 'Hook Test 1', short_name: 'HK1', role: 'CLIENT' }
            });

            executePacketTransactionPlan(
                plan1,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    logger: {
                        log: () => { throw new Error('LOGGER_LOG_BOOM'); },
                        error: (msg) => case1ErrorsLogged.push(msg)
                    },
                    recordLivePacketAnalytics: () => { case1AnalyticsCount++; },
                    batchEmit: (type, payload) => { case1Emits.push(type); }
                },
                (err, res) => {
                    case1CbCount++;
                    case1CbErr = err;
                    case1CbRes = res;
                }
            );

            // Case 2: recordLivePacketAnalytics 拋出例外 -> logger、batchEmit 與 caller callback 仍正常執行
            const case2ErrorsLogged = [];
            const case2Logs = [];
            const case2Emits = [];
            let case2CbCount = 0;
            let case2CbErr = 'NOT_CALLED';
            let case2CbRes = null;

            const plan2 = buildMqttPacketTransactionPlan({
                fromId: '!hook_node_2',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 702, hop_limit: 3, hop_start: 3, rx_snr: 8.5, rx_rssi: -71 },
                rawHex: 'AA02',
                decodedData: { portnum: 'NODEINFO_APP', channel_name: 'MediumFast' },
                payloadObj: { long_name: 'Hook Test 2', short_name: 'HK2', role: 'CLIENT' },
                nodeInfoData: { long_name: 'Hook Test 2', short_name: 'HK2', role: 'CLIENT' }
            });

            executePacketTransactionPlan(
                plan2,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    logger: {
                        log: (m) => case2Logs.push(m),
                        error: (msg) => case2ErrorsLogged.push(msg)
                    },
                    recordLivePacketAnalytics: () => { throw new Error('ANALYTICS_BOOM'); },
                    batchEmit: (type) => { case2Emits.push(type); }
                },
                (err, res) => {
                    case2CbCount++;
                    case2CbErr = err;
                    case2CbRes = res;
                }
            );

            // Case 3: batchEmit 拋出例外 -> logger、analytics、其餘 emit 與 caller callback 仍正常執行
            const case3ErrorsLogged = [];
            let case3AnalyticsCount = 0;
            const case3Emits = [];
            let case3CbCount = 0;
            let case3CbErr = 'NOT_CALLED';
            let case3CbRes = null;

            const plan3 = buildMqttPacketTransactionPlan({
                fromId: '!hook_node_3',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 703, hop_limit: 3, hop_start: 3, rx_snr: 9.0, rx_rssi: -72 },
                rawHex: 'AA03',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: 91 } },
                telemetryData: { batteryLevel: 91, finalVoltage: 4.12, finalCurrent: 80, temperature: 24.0, humidity: 55.0 }
            });

            let emitCallIdx = 0;
            executePacketTransactionPlan(
                plan3,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    logger: {
                        log: () => {},
                        error: (msg) => case3ErrorsLogged.push(msg)
                    },
                    recordLivePacketAnalytics: () => { case3AnalyticsCount++; },
                    batchEmit: (type) => {
                        emitCallIdx++;
                        if (emitCallIdx === 1) {
                            throw new Error('BATCH_EMIT_FIRST_EVENT_BOOM');
                        }
                        case3Emits.push(type);
                    }
                },
                (err, res) => {
                    case3CbCount++;
                    case3CbErr = err;
                    case3CbRes = res;
                }
            );

            await db.flushDbQueue();

            // 驗證 Case 1 (logger.log 失敗)
            assert.equal(case1CbCount, 1, 'Case 1 caller callback 必須精確執行 1 次');
            assert.equal(case1CbErr, null, 'Case 1 交易已提交，不得因 logger 失敗誤判為交易失敗');
            assert.equal(case1AnalyticsCount, 1, 'Case 1 analytics 仍應正常執行');
            assert.equal(case1Emits.length, 3, 'Case 1 batchEmit 仍應正常執行');
            assert.equal(case1ErrorsLogged.length, 1, 'Case 1 必須記錄 POST_COMMIT_HOOK_ERROR');
            assert.match(case1ErrorsLogged[0], /POST_COMMIT_HOOK_ERROR.*logger\.log/);
            assert.equal(case1CbRes.postCommitErrors.length, 1);

            // 驗證 Case 2 (recordLivePacketAnalytics 失敗)
            assert.equal(case2CbCount, 1, 'Case 2 caller callback 必須精確執行 1 次');
            assert.equal(case2CbErr, null, 'Case 2 交易已提交，不得因 analytics 失敗誤判為交易失敗');
            assert.equal(case2Logs.length, 1, 'Case 2 logger.log 仍應正常執行');
            assert.equal(case2Emits.length, 3, 'Case 2 batchEmit 仍應正常執行');
            assert.equal(case2ErrorsLogged.length, 1, 'Case 2 必須記錄 POST_COMMIT_HOOK_ERROR');
            assert.match(case2ErrorsLogged[0], /POST_COMMIT_HOOK_ERROR.*recordLivePacketAnalytics/);
            assert.equal(case2CbRes.postCommitErrors.length, 1);

            // 驗證 Case 3 (batchEmit 第一個事件失敗)
            assert.equal(case3CbCount, 1, 'Case 3 caller callback 必須精確執行 1 次');
            assert.equal(case3CbErr, null, 'Case 3 交易已提交，不得因 batchEmit 失敗誤判為交易失敗');
            assert.equal(case3AnalyticsCount, 1, 'Case 3 analytics 仍應正常執行');
            assert.equal(case3Emits.length, 2, 'Case 3 第 1 個 emit 拋錯後，剩餘 2 個 emit 仍應繼續執行');
            assert.equal(case3ErrorsLogged.length, 1, 'Case 3 必須記錄 POST_COMMIT_HOOK_ERROR');
            assert.match(case3ErrorsLogged[0], /POST_COMMIT_HOOK_ERROR.*batchEmit/);
            assert.equal(case3CbRes.postCommitErrors.length, 1);

            // 驗證 3 筆 SQLite 交易在資料庫中全部維持已提交狀態
            const committedNodes = await db.all('SELECT node_id FROM nodes ORDER BY node_id ASC');
            assert.deepEqual(committedNodes.map(n => n.node_id), ['!hook_node_1', '!hook_node_2', '!hook_node_3']);
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 9. 併發寫入 + 併發讀取 + BackupManager VACUUM INTO 備份一致性測試 (Section 五 #3)
    // =========================================================================
    it('Test 4.0.2-9 — Concurrent Packet Transactions, Concurrent Reads & Online Backup: 30 個以上封包交易併發執行期間同時進行讀取與 VACUUM INTO 備份，驗證讀取與備份皆無部分交易狀態', async () => {
        const dbPath = createTempPath('pkt_tx_conc_backup');
        const backupDir = createTempPath('pkt_tx_backups', '');
        fs.mkdirSync(backupDir, { recursive: true });

        const db = await createDatabaseSubsystem({
            dbPath,
            backupDir,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 5, flushIntervalMs: 10 } }
        });

        try {
            const totalPackets = 32; // > 25 個交易單位，分成多個批次提交
            const writePromises = [];
            const readObservations = [];
            let stopReaders = false;

            // 啟動持續併發讀取 Worker：檢查任一時間點讀取到的 nodes、packet_logs、telemetry_data 數量必須完全一致（無半套封包）
            const readerLoop = (async () => {
                while (!stopReaders) {
                    const snapshot = await db.get(`
                        SELECT
                            (SELECT COUNT(*) FROM nodes) AS nodes_cnt,
                            (SELECT COUNT(*) FROM packet_logs) AS logs_cnt,
                            (SELECT COUNT(*) FROM telemetry_data) AS tele_cnt
                    `);
                    readObservations.push(snapshot);
                    assert.equal(
                        snapshot.nodes_cnt,
                        snapshot.logs_cnt,
                        `併發讀取不可觀測到不一致狀態: nodes=${snapshot.nodes_cnt} !== logs=${snapshot.logs_cnt}`
                    );
                    assert.equal(
                        snapshot.logs_cnt,
                        snapshot.tele_cnt,
                        `併發讀取不可觀測到不一致狀態: logs=${snapshot.logs_cnt} !== tele=${snapshot.tele_cnt}`
                    );
                    await new Promise(r => setTimeout(r, 5));
                }
            })();

            // 分批推入 32 個跨表 TELEMETRY_APP 封包交易，並在寫入進行到一半時觸發真實 BackupManager.performBackup()
            let backupPromise = null;
            for (let i = 1; i <= totalPackets; i++) {
                const nodeId = `!cbkp${String(i).padStart(4, '0')}`;
                const plan = buildMqttPacketTransactionPlan({
                    fromId: nodeId,
                    topic: 'msh/TW/2/e/MediumFast/!gw_bkp',
                    resolvedChannel: 'MediumFast',
                    gatewayId: '!gw_bkp',
                    packet: { id: 2000 + i, hop_limit: 2, hop_start: 3, rx_snr: 7.5, rx_rssi: -80 },
                    rawHex: '112233',
                    decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                    payloadObj: { device_metrics: { battery_level: i } },
                    telemetryData: {
                        batteryLevel: i,
                        finalVoltage: 4.0,
                        finalCurrent: 100,
                        temperature: 25.0,
                        humidity: 60.0,
                        channelUtilization: 10,
                        airUtilTx: 1,
                        adcVoltage: 4.0
                    }
                });

                writePromises.push(
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

                if (i % 5 === 0) {
                    // 觸發非同步 Flush 讓批次交易在背景持續進行
                    db.flushDbQueue().catch(() => {});
                    await new Promise(r => setTimeout(r, 5));
                }

                if (i === 15) {
                    // 在交易持續進行期間啟動真實 VACUUM INTO 線上備份
                    backupPromise = db.backupManager.performBackup('concurrent_snapshot.db', { backupDir });
                }
            }

            const [backupResult] = await Promise.all([
                backupPromise,
                db.flushDbQueue(),
                Promise.all(writePromises)
            ]);
            stopReaders = true;
            await readerLoop;

            assert.ok(readObservations.length > 0, '交易執行期間必須實際執行併發讀取');
            assert.ok(backupResult, 'BackupManager.performBackup 必須回傳結果');
            assert.equal(backupResult.status, 'COMPLETED', '線上備份必須成功完成');
            assert.ok(fs.existsSync(backupResult.targetPath), '備份檔案必須實際存在於磁碟');

            // 開啟獨立備份資料庫檔案，驗證完整性與跨表交易一致性（無半套封包）
            const bkpIntegrity = await querySqliteAll(backupResult.targetPath, 'PRAGMA integrity_check');
            assert.equal(bkpIntegrity[0].integrity_check, 'ok', '備份資料庫 PRAGMA integrity_check 必須為 ok');

            const bkpCounts = await querySqliteAll(backupResult.targetPath, `
                SELECT
                    (SELECT COUNT(*) FROM nodes) AS nodes_cnt,
                    (SELECT COUNT(*) FROM packet_logs) AS logs_cnt,
                    (SELECT COUNT(*) FROM telemetry_data) AS tele_cnt
            `);
            const snap = bkpCounts[0];
            assert.ok(snap.nodes_cnt > 0, '備份檔案應包含已提交的封包資料');
            assert.equal(snap.nodes_cnt, snap.logs_cnt, '備份檔案中 nodes 與 packet_logs 筆數必須完全一致（無部分交易）');
            assert.equal(snap.logs_cnt, snap.tele_cnt, '備份檔案中 packet_logs 與 telemetry_data 筆數必須完全一致（無部分交易）');

            // 驗證主資料庫最終 32 個封包全數提交完成
            const finalMainCounts = await db.get(`
                SELECT
                    (SELECT COUNT(*) FROM nodes) AS nodes_cnt,
                    (SELECT COUNT(*) FROM packet_logs) AS logs_cnt,
                    (SELECT COUNT(*) FROM telemetry_data) AS tele_cnt
            `);
            assert.equal(finalMainCounts.nodes_cnt, totalPackets);
            assert.equal(finalMainCounts.logs_cnt, totalPackets);
            assert.equal(finalMainCounts.tele_cnt, totalPackets);
            assertDataConservation(db.writeQueue.getMetrics());
        } finally {
            await db.close();
            cleanupDbFiles(dbPath);
            cleanupDirRecursive(backupDir);
        }
    });

    // =========================================================================
    // 10. Shutdown 時的 Active Transaction Drain 測試 (Section 五 #4)
    // =========================================================================
    it('Test 4.0.2-10 — Shutdown Active Packet Transaction Drain: 交易執行中延遲並觸發 ShutdownHandler，確認等待進行中與排隊交易完成後才安全關閉資料庫', async () => {
        const dbPath = createTempPath('pkt_tx_shutdown_drain');
        const db = await createDatabaseSubsystem({
            dbPath,
            bootstrapSchema: true,
            config: { queue: { batchChunkSize: 1, flushIntervalMs: 5000 } }
        });

        try {
            const timeline = [];
            let tx1MidStepReachedResolve;
            const tx1MidStepReached = new Promise((resolve) => {
                tx1MidStepReachedResolve = resolve;
            });

            // 包裝 adapter.transaction 與 close，讓第 1 筆封包交易在第 2 條 SQL 處延遲 120ms，確保 Shutdown 發生時該交易正處於 Active In-Flight 狀態
            const origTransaction = db.adapter.transaction.bind(db.adapter);
            db.adapter.transaction = async (txFn) => {
                return origTransaction(async (tx) => {
                    let step = 0;
                    const delayedTx = {
                        ...tx,
                        execute: async (sql, params) => {
                            step++;
                            const res = await tx.execute(sql, params);
                            if (step === 2) {
                                timeline.push('TX1_MID_FLIGHT_REACHED');
                                if (tx1MidStepReachedResolve) {
                                    tx1MidStepReachedResolve();
                                    tx1MidStepReachedResolve = null;
                                }
                                await new Promise(r => setTimeout(r, 120));
                                timeline.push('TX1_DELAY_FINISHED');
                            }
                            return res;
                        }
                    };
                    const out = await txFn(delayedTx);
                    timeline.push('ACTIVE_TX_COMMITTED');
                    return out;
                });
            };

            const origClose = db.adapter.close.bind(db.adapter);
            db.adapter.close = async (...args) => {
                timeline.push('ADAPTER_CLOSE_CALLED');
                return origClose(...args);
            };

            let cb1Count = 0;
            let cb1Err = null;
            let cb2Count = 0;
            let cb2Err = null;

            const plan1 = buildMqttPacketTransactionPlan({
                fromId: '!drain_node_1',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 801, hop_limit: 3, hop_start: 3, rx_snr: 9.0, rx_rssi: -70 },
                rawHex: 'AA01',
                decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                payloadObj: { text: 'In-flight active transaction during shutdown', channel_name: 'MediumFast' }
            });

            const plan2 = buildMqttPacketTransactionPlan({
                fromId: '!drain_node_2',
                topic: 'msh/TW/2/e/MediumFast/!gw01',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw01',
                packet: { id: 802, hop_limit: 3, hop_start: 3, rx_snr: 9.5, rx_rssi: -68 },
                rawHex: 'AA02',
                decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                payloadObj: { text: 'Queued transaction drained during shutdown', channel_name: 'MediumFast' }
            });

            // 排入 plan1 (因為 batchChunkSize=1 會立即啟動 flush 進入 active transaction)
            executePacketTransactionPlan(
                plan1,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    batchEmit: () => {},
                    recordLivePacketAnalytics: () => {},
                    logger: { log: () => {}, error: () => {} }
                },
                (err) => {
                    cb1Count++;
                    cb1Err = err;
                    timeline.push('CB1_INVOKED');
                }
            );

            // 等待 plan1 進入交易中段 (尚未完成、尚未 COMMIT)
            await tx1MidStepReached;

            // 在 plan1 仍在交易中段時，再排入 plan2 並立即觸發 ShutdownHandler.handle('SIGTERM')
            executePacketTransactionPlan(
                plan2,
                {
                    enqueuePacketTransaction: db.queuePacketTransaction.bind(db),
                    batchEmit: () => {},
                    recordLivePacketAnalytics: () => {},
                    logger: { log: () => {}, error: () => {} }
                },
                (err) => {
                    cb2Count++;
                    cb2Err = err;
                    timeline.push('CB2_INVOKED');
                }
            );

            timeline.push('SHUTDOWN_TRIGGERED');
            await db.shutdownHandler.handle('SIGTERM', { exitProcess: false });

            // 驗證：Shutdown 發生在 TX1 交易中段之後，但資料庫關閉 (ADAPTER_CLOSE_CALLED) 必須發生在 TX1 與 TX2 皆完成提交與 callback 之後！
            const midIdx = timeline.indexOf('TX1_MID_FLIGHT_REACHED');
            const shutdownIdx = timeline.indexOf('SHUTDOWN_TRIGGERED');
            const delayDoneIdx = timeline.indexOf('TX1_DELAY_FINISHED');
            const cb1Idx = timeline.indexOf('CB1_INVOKED');
            const cb2Idx = timeline.indexOf('CB2_INVOKED');
            const closeIdx = timeline.indexOf('ADAPTER_CLOSE_CALLED');

            assert.ok(midIdx !== -1 && shutdownIdx > midIdx, 'Shutdown 必須在交易仍在進行中時觸發');
            assert.ok(delayDoneIdx > shutdownIdx, '交易延遲結束必須在 Shutdown 觸發之後');
            assert.ok(cb1Idx > delayDoneIdx && cb1Idx < closeIdx, '進行中交易之 callback 必須在關閉連線前完成');
            assert.ok(cb2Idx > cb1Idx && cb2Idx < closeIdx, '佇列中交易之 callback 必須在關閉連線前完成');

            assert.equal(cb1Count, 1, 'CB1 必須精確執行 1 次');
            assert.equal(cb1Err, null, '進行中交易必須成功提交');
            assert.equal(cb2Count, 1, 'CB2 必須精確執行 1 次');
            assert.equal(cb2Err, null, '排隊交易必須在 Drain 階段成功提交');

            // 重新開啟資料庫驗證兩筆交易皆完整持久化且資料庫無損壞
            const rows = await querySqliteAll(dbPath, 'SELECT node_id, message FROM chat_messages ORDER BY node_id ASC');
            assert.equal(rows.length, 2, '兩筆封包交易皆應完整寫入資料庫');
            assert.deepEqual(rows.map(r => r.node_id), ['!drain_node_1', '!drain_node_2']);

            const integrity = await querySqliteAll(dbPath, 'PRAGMA integrity_check');
            assert.equal(integrity[0].integrity_check, 'ok');
        } finally {
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 11. 未知節點先到達、COALESCE 與 RF Tunnel 相容性測試 (Section 七)
    // =========================================================================
    it('Test 4.0.2-11 — Unknown Node Pre-NODEINFO Arrival & COALESCE / RF Tunnel Semantics: 未知節點先收到封包可正常寫入，後續 NODEINFO 與 COALESCE 更新語意完全相容', async () => {
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
    // 12. P1：Turso 實際隊列入口與 Sequential Fallback 多語句順序執行與混合佇列測試 (Section 二)
    // =========================================================================
    it('Test 4.0.2-12 — Turso Actual Queue Entry & Flush Path (queuePacketTransaction -> dbQueue -> flushDbQueue -> executeSequentialFallbackItem): 驗證透過與 index.js 共用的實際佇列調度器入列、混合單筆 queueDbOp 與多語句封包交易、中段失敗停止與 callback exactly-once', async () => {
        const executedCalls = [];
        let failAtCallIndex = -1;

        // 1. 使用與 index.js TURSO_URL 分支完全共用的 createTursoDbWrapper 與 createSequentialFallbackQueueController
        const mockLibsqlClient = {
            execute: async ({ sql, args }) => {
                const currentIdx = executedCalls.length;
                executedCalls.push({ sql, args });
                if (currentIdx === failAtCallIndex) {
                    throw new Error(`MOCK_TURSO_SQL_FAILURE_AT_STEP_${currentIdx}`);
                }
                return { lastInsertRowid: BigInt(100 + currentIdx), rowsAffected: 1, rows: [] };
            }
        };

        const mockTursoDb = createTursoDbWrapper(mockLibsqlClient);
        assert.equal(mockTursoDb.isTursoFallback, true);
        assert.equal(typeof mockTursoDb.queuePacketTransaction, 'undefined', 'Turso wrapper 無 Local SQLite queuePacketTransaction');
        assert.equal(typeof mockTursoDb.queueDbOp, 'undefined', 'Turso wrapper 無 Local SQLite queueDbOp');

        const sharedDbQueue = [];
        const sharedMetrics = {
            totalQueued: 0,
            totalCommitted: 0,
            totalErrors: 0,
            lastBatchSize: 0,
            lastDurationMs: 0,
            maxQueueLengthSeen: 0
        };
        const queueController = createSequentialFallbackQueueController({
            getDb: () => mockTursoDb,
            dbQueue: sharedDbQueue,
            dbQueueMetrics: sharedMetrics,
            maxQueueCapacity: 5000,
            batchChunkSize: 100,
            flushIntervalMs: 5000, // 長防抖時間以便測試直接驗證 dbQueue 實際入列狀態後再呼叫 flushDbQueue()
            logger: { log: () => {}, warn: () => {}, error: () => {} }
        });

        try {
            // --- Subcase A: 透過 queuePacketTransaction() 入列至實際 dbQueue，再由 flushDbQueue() 執行 4 條 SQL ---
            const telePlan = buildMqttPacketTransactionPlan({
                fromId: '!turso001',
                topic: 'msh/TW/2/e/MediumFast/!gw_turso',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw_turso',
                packet: { id: 901, hop_limit: 2, hop_start: 3, rx_snr: 9.0, rx_rssi: -75 },
                rawHex: 'FFEE',
                decodedData: { portnum: 'TELEMETRY_APP', channel_name: 'MediumFast' },
                payloadObj: { device_metrics: { battery_level: 85 } },
                telemetryData: { batteryLevel: 85, finalVoltage: 4.08, finalCurrent: 90, temperature: 25.0, humidity: 60.0 }
            });
            assert.equal(telePlan.statements.length, 4);

            const subcaseAOrder = [];
            let subcaseACbCount = 0;
            let subcaseAResult = null;

            const enqueuedOk = executePacketTransactionPlan(
                telePlan,
                {
                    enqueuePacketTransaction: queueController.queuePacketTransaction,
                    recordLivePacketAnalytics: () => subcaseAOrder.push('POST_ANALYTICS'),
                    batchEmit: (type) => subcaseAOrder.push(`POST_EMIT:${type}`),
                    logger: { log: () => subcaseAOrder.push('POST_LOG'), error: () => {} }
                },
                (err, res) => {
                    subcaseACbCount++;
                    if (err) throw err;
                    subcaseAResult = res;
                    subcaseAOrder.push('CALLER_CALLBACK');
                }
            );
            assert.equal(enqueuedOk, true, 'queuePacketTransaction 必須回傳 true');

            // 驗證 2 & 3：在 flushDbQueue() 前，交易單位確實進入實際 sharedDbQueue 且標記 isTransactionUnit: true
            assert.equal(sharedDbQueue.length, 1, '交易單位必須進入實際 dbQueue');
            assert.equal(sharedDbQueue[0].isTransactionUnit, true, 'dbQueue 項目必須標記 isTransactionUnit === true');
            assert.equal(sharedDbQueue[0].statements.length, 4, 'dbQueue 項目必須保留完整 4 條 statements');
            assert.equal(sharedDbQueue[0].label, telePlan.label, 'dbQueue 項目必須保留交易標籤');
            assert.equal(executedCalls.length, 0, 'flushDbQueue 執行前尚未執行 SQL');

            await queueController.flushDbQueue();

            assert.equal(sharedDbQueue.length, 0, 'flushDbQueue 完成後 dbQueue 應排空');
            assert.equal(executedCalls.length, 4, 'Turso fallback 必須完整執行全部 4 條 SQL，不得只執行第 1 條');
            for (let i = 0; i < 4; i++) {
                assert.equal(executedCalls[i].sql, telePlan.statements[i].sql, `第 ${i} 條 SQL 順序必須完全一致`);
                assert.notEqual(executedCalls[i].sql, telePlan.label, '絕不可把 options.label 當成 SQL 執行');
            }
            assert.equal(subcaseACbCount, 1, '成功 callback 必須精確執行 1 次');
            assert.equal(subcaseAResult.statementCount, 4);
            assert.equal(subcaseAResult.isTursoSequentialFallback, true);
            assert.ok(subcaseAOrder.includes('POST_ANALYTICS'), '所有 SQL 成功後才執行 analytics');
            assert.ok(subcaseAOrder.includes('POST_EMIT:telemetry_update'), '所有 SQL 成功後才執行 batchEmit');
            assert.equal(subcaseAOrder[subcaseAOrder.length - 1], 'CALLER_CALLBACK', 'caller callback 在 post-commit hooks 後執行');

            // --- Subcase B: 透過 queuePacketTransaction() 入列，中途第 2 條 SQL (index=1) 失敗 ---
            executedCalls.length = 0;
            failAtCallIndex = 1; // 讓第 2 條 SQL 失敗

            const subcaseBEffects = [];
            let subcaseBCbCount = 0;
            let subcaseBErr = null;

            executePacketTransactionPlan(
                telePlan,
                {
                    enqueuePacketTransaction: queueController.queuePacketTransaction,
                    recordLivePacketAnalytics: () => subcaseBEffects.push('ANALYTICS'),
                    batchEmit: (type) => subcaseBEffects.push(`EMIT:${type}`),
                    logger: { log: () => subcaseBEffects.push('LOG'), error: () => {} }
                },
                (err) => {
                    subcaseBCbCount++;
                    subcaseBErr = err;
                }
            );
            assert.equal(sharedDbQueue.length, 1, '失敗測試項目同樣先進入 dbQueue');

            await queueController.flushDbQueue();

            assert.equal(executedCalls.length, 2, '第 2 條 SQL 失敗後必須立即中止，不得繼續執行第 3、4 條 SQL');
            assert.equal(subcaseBCbCount, 1, '錯誤 callback 必須精確觸發 1 次');
            assert.ok(subcaseBErr, '必須收到錯誤物件');
            assert.equal(subcaseBErr.failedStatementIndex, 1, '應記錄失敗於 index=1');
            assert.equal(subcaseBErr.failedStatementSql, telePlan.statements[1].sql);
            assert.equal(subcaseBErr.transactionLabel, telePlan.label);
            assert.equal(subcaseBEffects.length, 0, '中途失敗時不得執行任何成功的 post-commit effects');

            // --- Subcase C: 同一個 dbQueue 中混合一般單筆 queueDbOp() 與多語句 queuePacketTransaction() ---
            executedCalls.length = 0;
            failAtCallIndex = 5; // 順序為: [0] singleOp1 -> [1,2,3] chatPlan (3 條) -> [4] singleOp2 -> [5(FAIL),6] rfPlan (第 1 筆失敗) -> [6] singleOp3

            const mixedTimeline = [];
            let single1CbCount = 0;
            let chatTxCbCount = 0;
            let single2CbCount = 0;
            let rfTxCbCount = 0;
            let rfTxErr = null;
            let single3CbCount = 0;

            const chatPlan = buildMqttPacketTransactionPlan({
                fromId: '!turso_mix_chat',
                topic: 'msh/TW/2/e/MediumFast/!gw_turso',
                resolvedChannel: 'MediumFast',
                gatewayId: '!gw_turso',
                packet: { id: 902, hop_limit: 3, hop_start: 3, rx_snr: 10.0, rx_rssi: -70 },
                rawHex: 'AABB',
                decodedData: { portnum: 'TEXT_MESSAGE_APP', channel_name: 'MediumFast' },
                payloadObj: { text: 'Mixed queue chat packet', channel_name: 'MediumFast' }
            });
            assert.equal(chatPlan.statements.length, 3);

            const rfPlan = buildRfTunnelPacketTransactionPlan({
                fromId: '!turso_mix_rf',
                gatewayId: 'RELAY_MIX',
                snr: 6.5,
                rssi: -85,
                lat: 24.0,
                lng: 121.0,
                hopsAway: 1,
                sourceName: 'hualien',
                sourceLabel: '花蓮站',
                packetData: { from: '!turso_mix_rf', portnum: 'POSITION' }
            });
            assert.equal(rfPlan.statements.length, 2);

            // 依序排入同一個 sharedDbQueue:
            // Item 1: 一般 queueDbOp
            queueController.queueDbOp('DELETE FROM chat_messages WHERE id = ?', [10], (err) => {
                assert.equal(err, null);
                single1CbCount++;
                mixedTimeline.push('SINGLE_OP_1_CB');
            });

            // Item 2: 3 條 SQL 的 Packet Transaction (成功)
            executePacketTransactionPlan(
                chatPlan,
                {
                    enqueuePacketTransaction: queueController.queuePacketTransaction,
                    batchEmit: (t) => mixedTimeline.push(`CHAT_TX_EMIT:${t}`),
                    recordLivePacketAnalytics: () => mixedTimeline.push('CHAT_TX_ANALYTICS'),
                    logger: { log: () => {}, error: () => {} }
                },
                (err) => {
                    assert.equal(err, null);
                    chatTxCbCount++;
                    mixedTimeline.push('CHAT_TX_CB');
                }
            );

            // Item 3: 一般 queueDbOp (2 參數無 params 陣列呼叫形式)
            queueController.queueDbOp('DELETE FROM telemetry_data WHERE id < 5', (err) => {
                assert.equal(err, null);
                single2CbCount++;
                mixedTimeline.push('SINGLE_OP_2_CB');
            });

            // Item 4: 2 條 SQL 的 RF Packet Transaction (在第 1 條 SQL 即全域 call index=5 處失敗)
            executePacketTransactionPlan(
                rfPlan,
                {
                    enqueuePacketTransaction: queueController.queuePacketTransaction,
                    batchEmit: (t) => mixedTimeline.push(`RF_TX_SHOULD_NOT_EMIT:${t}`),
                    logger: { log: () => {}, error: () => {} }
                },
                (err) => {
                    rfTxCbCount++;
                    rfTxErr = err;
                    mixedTimeline.push('RF_TX_ERROR_CB');
                }
            );

            // Item 5: 一般 queueDbOp (驗證前一個交易失敗不會破壞同佇列後續一般 SQL 的順序與 callback)
            queueController.queueDbOp('UPDATE nodes SET is_favorite = 1 WHERE node_id = ?', ['!turso_mix_chat'], (err) => {
                assert.equal(err, null);
                single3CbCount++;
                mixedTimeline.push('SINGLE_OP_3_CB');
            });

            assert.equal(sharedDbQueue.length, 5, '5 個混合項目應同時排入 sharedDbQueue');
            assert.deepEqual(
                sharedDbQueue.map(item => item.isTransactionUnit),
                [false, true, false, true, false],
                'dbQueue 中一般 SQL 與 Packet Transaction 的 isTransactionUnit 標記必須精確對應'
            );

            await queueController.flushDbQueue();

            // 驗證總執行 SQL 數：1 (Single1) + 3 (ChatTx) + 1 (Single2) + 1 (RfTx 第 1 條失敗，第 2 條不執行) + 1 (Single3) = 7 條 SQL
            assert.equal(executedCalls.length, 7, '混合佇列應精確執行 7 條 SQL（RF 交易第 2 條因第 1 條失敗而停止）');
            assert.equal(single1CbCount, 1);
            assert.equal(chatTxCbCount, 1);
            assert.equal(single2CbCount, 1);
            assert.equal(rfTxCbCount, 1);
            assert.ok(rfTxErr, 'RF 交易失敗必須傳遞錯誤給 callback');
            assert.equal(rfTxErr.failedStatementIndex, 0);
            assert.equal(single3CbCount, 1, '後續一般 queueDbOp 仍須正常執行並觸發 callback 1 次');

            // 驗證 Callback 與副作用嚴格保持 FIFO 順序，且失敗的 RF 交易 0 副作用
            assert.ok(!mixedTimeline.some(e => e.startsWith('RF_TX_SHOULD_NOT_EMIT')), '失敗的交易不得觸發 emit');
            const idxSingle1 = mixedTimeline.indexOf('SINGLE_OP_1_CB');
            const idxChatTx = mixedTimeline.indexOf('CHAT_TX_CB');
            const idxSingle2 = mixedTimeline.indexOf('SINGLE_OP_2_CB');
            const idxRfErr = mixedTimeline.indexOf('RF_TX_ERROR_CB');
            const idxSingle3 = mixedTimeline.indexOf('SINGLE_OP_3_CB');
            assert.ok(
                idxSingle1 < idxChatTx && idxChatTx < idxSingle2 && idxSingle2 < idxRfErr && idxRfErr < idxSingle3,
                `混合隊列回呼順序必須嚴格符合 FIFO: ${JSON.stringify(mixedTimeline)}`
            );
        } finally {
            queueController.stopTimer();
        }
    });

    // =========================================================================
    // 13. Backup Scheduler Policy 實際共用函式與動態狀態驗證測試 (Section 三)
    // =========================================================================
    it('Test 4.0.2-13 — Backup Scheduler Policy Shared Function Verification: 驗證 index.js 共用 registerAppBackupSchedule / createAppBackupSchedulePolicy 之四種情境 (A/B/C/D) 與 Cron 凍結政策', async () => {
        const dbPath = createTempPath('policy_check');
        const backupDir = createTempPath('policy_backups', '');
        fs.mkdirSync(backupDir, { recursive: true });

        const db = await createDatabaseSubsystem({ dbPath, backupDir, bootstrapSchema: true });
        try {
            // 寫入一筆測試節點資料，讓排程備份觸發時可驗證備份檔內容
            await db.run(`INSERT INTO nodes (node_id, long_name, short_name) VALUES ('!sched001', 'ScheduledNode', 'SCH1')`);

            assert.equal(sqliteConfig.backup.cronSchedule, '0 4 * * *', 'sqlite.config.js 預設 cronSchedule 應維持 0 4 * * *');
            assert.equal(APP_BACKUP_CRON_EXPRESSION, '0 0 * * 0', 'index.js 實際備份排程政策應維持 0 0 * * 0');

            let registeredCronExpr = null;
            let scheduledTickFn = null;
            const fakeCron = {
                validate: (expr) => expr === '0 0 * * 0',
                schedule: (expr, tickCallback) => {
                    registeredCronExpr = expr;
                    scheduledTickFn = tickCallback;
                    return { stop: () => {} };
                }
            };

            // 使用受控環境變數物件傳入與 index.js 完全共用的 registerAppBackupSchedule(db, fakeCron, mockEnv)
            const mockEnv = {};
            let performBackupCallCount = 0;
            const origPerformBackup = db.backupManager.performBackup.bind(db.backupManager);
            db.backupManager.performBackup = async (...args) => {
                performBackupCallCount++;
                return origPerformBackup(...args);
            };

            const registration = registerAppBackupSchedule(db, fakeCron, mockEnv);
            assert.ok(registration, 'registerAppBackupSchedule 必須成功註冊排程');
            assert.equal(registeredCronExpr, '0 0 * * 0', '實際註冊至 cron.schedule 的表達式必須為 0 0 * * 0');
            assert.equal(typeof scheduledTickFn, 'function', '必須註冊排程觸發回呼');

            const { policy } = registration;

            // --- 情境 A：未設定 BACKUP_PATH ---
            delete mockEnv.BACKUP_PATH;
            assert.equal(db.isBootstrapReady(), true);
            assert.equal(policy.shouldRun(), false, '情境 A：未設定 BACKUP_PATH 時 shouldRun() 必須回傳 false');
            const tickResultA = await scheduledTickFn();
            assert.equal(tickResultA.skipped, true, '情境 A：排程觸發必須略過');
            assert.equal(performBackupCallCount, 0, '情境 A：不得呼叫 performBackup()');
            assert.equal(fs.readdirSync(backupDir).length, 0, '情境 A：不得意外產生本地備份檔案');

            // --- 情境 B：設定 BACKUP_PATH，但 Schema 尚未 Ready ---
            mockEnv.BACKUP_PATH = backupDir;
            db.isSchemaReady = false;
            assert.equal(db.isBootstrapReady(), false, 'Schema 未就緒時 db.isBootstrapReady() 為 false');
            assert.equal(policy.shouldRun(), false, '情境 B：設定 BACKUP_PATH 但 Schema 尚未 Ready 時 shouldRun() 必須回傳 false');
            const tickResultB = await scheduledTickFn();
            assert.equal(tickResultB.skipped, true, '情境 B：排程觸發必須略過');
            assert.equal(performBackupCallCount, 0, '情境 B：不得執行備份');
            assert.equal(fs.readdirSync(backupDir).length, 0, '情境 B：不得產生備份檔案');

            // --- 情境 C：設定 BACKUP_PATH，且 Bootstrap Ready ---
            db.isSchemaReady = true;
            assert.equal(db.isBootstrapReady(), true, 'Schema 就緒時 db.isBootstrapReady() 為 true');
            assert.equal(policy.shouldRun(), true, '情境 C：設定 BACKUP_PATH 且 Bootstrap Ready 時 shouldRun() 必須回傳 true');
            const tickResultC = await scheduledTickFn();
            assert.ok(tickResultC, '情境 C：排程器應正常觸發備份流程並回傳結果');
            assert.equal(tickResultC.status, 'COMPLETED', '情境 C：排程觸發之備份必須成功完成');
            assert.equal(performBackupCallCount, 1, '情境 C：performBackup() 應精確執行 1 次');
            const filesAfterC = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
            assert.equal(filesAfterC.length, 1, '情境 C：BACKUP_PATH 目錄下應產生 1 份 .db 備份檔');
            assert.match(filesAfterC[0], /^meshtastic_backup_\d{4}-\d{2}-\d{2}\.db$/);

            // --- 情境 D：Bootstrap Ready 狀態與 BACKUP_PATH 發生動態變化 ---
            // 確認同一個已註冊的排程在後續觸發時動態使用當下狀態，絕不沿用初始化或上一次觸發時的舊狀態
            db.bootstrapError = new Error('SIMULATED_RUNTIME_BOOTSTRAP_FAULT');
            assert.equal(db.isBootstrapReady(), false, '模擬狀態變化後 isBootstrapReady() 變為 false');
            assert.equal(policy.shouldRun(), false, '情境 D-1：Bootstrap Ready 變為 false 時 shouldRun() 必須立即反映為 false');
            const tickResultD1 = await scheduledTickFn();
            assert.equal(tickResultD1.skipped, true);
            assert.equal(performBackupCallCount, 1, '情境 D-1：狀態變為不就緒後觸發排程不得再執行 performBackup()');

            // 恢復 Bootstrap Ready 狀態，再次觸發應可執行
            db.bootstrapError = null;
            assert.equal(db.isBootstrapReady(), true);
            assert.equal(policy.shouldRun(), true, '情境 D-2：狀態恢復為 Ready 後 shouldRun() 立即回傳 true');
            const tickResultD2 = await scheduledTickFn();
            assert.equal(tickResultD2.status, 'COMPLETED');
            assert.equal(performBackupCallCount, 2, '情境 D-2：狀態恢復後排程應再次成功執行 performBackup()');
        } finally {
            db.backupManager.stopSchedule();
            await db.close();
            cleanupDbFiles(dbPath);
            cleanupDirRecursive(backupDir);
        }
    });

    // =========================================================================
    // 14. SQLite WAL Engine Process Death Recovery Test (SIGKILL) (Section 五 #6 Part 1)
    // =========================================================================
    it('Test 4.0.2-14 — SQLite WAL Process Death Recovery Test (SIGKILL): 驗證原生 SQLite WAL 連線在交易前、交易中段未提交、COMMIT 後遭遇跨行程 SIGKILL 之 WAL 恢復', async () => {
        const dbPath = createTempPath('wal_engine_sigkill');
        const workerScript = path.join(__dirname, 'helpers', 'sigkill_tx_worker.js');

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
                    child.kill('SIGKILL');
                };

                child.on('message', (msg) => {
                    if (msg && msg.stage === expectedStage) onStageReady();
                });

                child.stdout.on('data', (chunk) => {
                    stdoutBuf += chunk.toString('utf8');
                    if (stdoutBuf.includes(`"stage":"${expectedStage}"`)) onStageReady();
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
            await runWorkerAndSigkillAtGate('AFTER_COMMIT', '!aaaa0001', 'READY_FOR_SIGKILL_AFTER_COMMIT');
            await runWorkerAndSigkillAtGate('BEFORE_TX', '!00000000', 'READY_FOR_SIGKILL_BEFORE_TX');
            await runWorkerAndSigkillAtGate('MID_TX_UNCOMMITTED', '!bbbb0002', 'READY_FOR_SIGKILL_MID_TX');

            const recoveredDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });
            try {
                const integrityRow = await recoveredDb.get('PRAGMA integrity_check');
                assert.equal(integrityRow.integrity_check, 'ok');

                const survivorNode = await recoveredDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!aaaa0001']);
                const survivorLogs = await recoveredDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!aaaa0001']);
                const survivorTele = await recoveredDb.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!aaaa0001']);
                assert.ok(survivorNode);
                assert.equal(survivorLogs.length, 1);
                assert.equal(survivorTele.length, 1);

                const ghostNode = await recoveredDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!bbbb0002']);
                const ghostLogs = await recoveredDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!bbbb0002']);
                const ghostChat = await recoveredDb.all('SELECT * FROM chat_messages WHERE node_id = ?', ['!bbbb0002']);
                const ghostNb = await recoveredDb.all('SELECT * FROM neighbors WHERE node_id = ?', ['!bbbb0002']);
                const ghostTele = await recoveredDb.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!bbbb0002']);

                assert.equal(ghostNode, null);
                assert.equal(ghostLogs.length, 0);
                assert.equal(ghostChat.length, 0);
                assert.equal(ghostNb.length, 0);
                assert.equal(ghostTele.length, 0);
            } finally {
                await recoveredDb.close();
            }
        } finally {
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 15. Application Packet Transaction Process Death Recovery Test (SIGKILL) (Section 五 #6 Part 2)
    // =========================================================================
    it('Test 4.0.2-15 — Application Packet Transaction Process Death Test (SIGKILL): 驗證經過專案 WriteQueue 與 PacketTransaction 路徑在執行第 3/4 步中段與 COMMIT 後遭遇 SIGKILL 之原子性恢復', async () => {
        const dbPath = createTempPath('app_packet_tx_sigkill');
        const workerScript = path.join(__dirname, 'helpers', 'sigkill_tx_worker.js');

        const initDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });
        await initDb.close();

        function runAppWorkerAndSigkill(mode, nodeId, expectedStage) {
            return new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [workerScript, mode, dbPath, nodeId], {
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                });

                let stageReached = false;
                let stdoutBuf = '';
                let stderrBuf = '';

                const onStageReady = () => {
                    if (stageReached) return;
                    stageReached = true;
                    child.kill('SIGKILL');
                };

                child.on('message', (msg) => {
                    if (msg && msg.stage === expectedStage) onStageReady();
                });

                child.stdout.on('data', (chunk) => {
                    stdoutBuf += chunk.toString('utf8');
                    if (stdoutBuf.includes(`"stage":"${expectedStage}"`)) onStageReady();
                });

                child.stderr.on('data', (chunk) => {
                    stderrBuf += chunk.toString('utf8');
                });

                child.on('error', reject);
                child.on('exit', (code, signal) => {
                    if (!stageReached) {
                        return reject(new Error(`App Worker (${mode}) exited before ${expectedStage} (code=${code}, signal=${signal}, stdout=${stdoutBuf}, stderr=${stderrBuf})`));
                    }
                    resolve({ code, signal });
                });
            });
        }

        try {
            // 1. 透過專案 WriteQueue + executePacketTransactionPlan 完成 COMMIT 後立即 SIGKILL (!app_surv_01)
            await runAppWorkerAndSigkill('APP_PACKET_TX_AFTER_COMMIT', '!app_surv_01', 'READY_FOR_SIGKILL_APP_PACKET_TX_AFTER_COMMIT');

            // 2. 透過專案 WriteQueue + executePacketTransactionPlan 執行 TELEMETRY_APP 前 3 條 SQL (nodes insert, packet_logs insert, nodes update)，在第 4 條 SQL 與 COMMIT 前遭 SIGKILL (!app_ghost_02)
            await runAppWorkerAndSigkill('APP_PACKET_TX_MID_FLIGHT', '!app_ghost_02', 'READY_FOR_SIGKILL_APP_PACKET_TX_MID_FLIGHT');

            // 3. 重新以專案 createDatabaseSubsystem 開啟資料庫驗證
            const recoveredDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: true });
            try {
                const integrityRow = await recoveredDb.get('PRAGMA integrity_check');
                assert.equal(integrityRow.integrity_check, 'ok');

                // 已完成 COMMIT 的封包交易 (!app_surv_01) 在 3 張關聯表均完整保留
                const survNode = await recoveredDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!app_surv_01']);
                const survLogs = await recoveredDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!app_surv_01']);
                const survTele = await recoveredDb.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!app_surv_01']);
                assert.ok(survNode, 'Application Packet Transaction COMMIT 後遭 SIGKILL 的節點必須存在');
                assert.equal(survNode.battery_level, 77);
                assert.equal(survLogs.length, 1);
                assert.equal(survTele.length, 1);

                // 在 WriteQueue 交易中段 (已執行 3/4 條 SQL) 遭 SIGKILL 的封包 (!app_ghost_02) 必須完全回滾、0 殘留
                const ghostNode = await recoveredDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!app_ghost_02']);
                const ghostLogs = await recoveredDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!app_ghost_02']);
                const ghostTele = await recoveredDb.all('SELECT * FROM telemetry_data WHERE node_id = ?', ['!app_ghost_02']);
                assert.equal(ghostNode, null, 'Application Packet Transaction 中段 SIGKILL 的 nodes 寫入必須完全回滾');
                assert.equal(ghostLogs.length, 0, 'Application Packet Transaction 中段 SIGKILL 的 packet_logs 寫入必須完全回滾');
                assert.equal(ghostTele.length, 0, 'Application Packet Transaction 中段 SIGKILL 的 telemetry_data 必須為 0');
            } finally {
                await recoveredDb.close();
            }
        } finally {
            cleanupDbFiles(dbPath);
        }
    });

    // =========================================================================
    // 16. 完整 index.js 子程序啟動 + 本機測試 Broker Wire-Level MQTT PUBLISH + 安全關機整合測試 (Section 五 #5 & Scope 3.2)
    // =========================================================================
    it('Test 4.0.2-16 — Full index.js Startup, Real Wire-Level MQTT Broker PUBLISH & Graceful Shutdown: 透過本機測試 Broker 真正發送 MQTT Wire-Level PUBLISH 二進位封包至 index.js 子程序，驗證啟動屏障、封包交易提交與安全關機', async () => {
        const dbPath = createTempPath('index_full_startup');
        const eventLogPath = createTempPath('index_events', '.json');
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        const httpPort = await getFreeTcpPort();
        const appEntryPath = path.resolve(__dirname, '..', '..', 'index.js');

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
            let mqttSubscribedLoggedAt = null;
            let seqCounter = 0;

            let resolveServerReady;
            let resolveMqttSubscribed;
            let resolveNodeInfoCommitted;
            let startupTimer;
            let mqttTimer;
            let nodeInfoTimer;

            const serverReadyPromise = new Promise((resolve, reject) => {
                resolveServerReady = () => {
                    clearTimeout(startupTimer);
                    resolve();
                };
                startupTimer = setTimeout(() => reject(new Error(`index.js startup timeout. stdout:\n${stdoutLog}\nstderr:\n${stderrLog}`)), 5000);
            });

            const mqttSubscribedPromise = new Promise((resolve, reject) => {
                resolveMqttSubscribed = () => {
                    clearTimeout(mqttTimer);
                    resolve();
                };
                mqttTimer = setTimeout(() => reject(new Error(`index.js MQTT subscribe timeout. stdout:\n${stdoutLog}\nstderr:\n${stderrLog}`)), 5000);
            });

            const nodeInfoCommittedPromise = new Promise((resolve, reject) => {
                resolveNodeInfoCommitted = () => {
                    clearTimeout(nodeInfoTimer);
                    resolve();
                };
                nodeInfoTimer = setTimeout(() => reject(new Error(`Wire-level MQTT packet commit timeout. stdout:\n${stdoutLog}\nstderr:\n${stderrLog}`)), 5000);
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
                    MQTT_PIPE_PATH: mockBroker.pipePath,
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
                    if (line.includes('📡 訂閱成功！正在監聽:') && mqttSubscribedLoggedAt === null) {
                        mqttSubscribedLoggedAt = ++seqCounter;
                        resolveMqttSubscribed();
                    }
                    if (line.includes('👤 [節點資訊] 更新: WIR1 角色:')) {
                        resolveNodeInfoCommitted();
                    }
                }
            });

            child.stderr.on('data', (chunk) => {
                stderrLog += chunk.toString('utf8');
            });

            // 等待 HTTP Server 啟動且 MQTT Client 完成真實 CONNECT -> CONNACK -> SUBSCRIBE -> SUBACK 握手
            await Promise.all([
                serverReadyPromise,
                mqttSubscribedPromise,
                mockBroker.waitForSubscription()
            ]);

            assert.ok(bootstrapLoggedAt !== null, '必須輸出 [BOOTSTRAP] 完成日誌');
            assert.ok(httpListenLoggedAt !== null, '必須輸出 HTTP 伺服器啟動日誌');
            assert.ok(mqttSubscribedLoggedAt !== null, '必須完成真實 MQTT SUBSCRIBE 握手');
            assert.ok(bootstrapLoggedAt < httpListenLoggedAt, 'Database Schema Bootstrap 必須早於 HTTP 服務啟動');

            // 透過本機測試 Broker 真正發送 Wire-Level MQTT PUBLISH (0x30) 二進位封包至 index.js 子程序
            const userPayload = User.encode(User.create({
                id: '!abcd1234',
                long_name: 'WireLevelBrokerNode',
                short_name: 'WIR1',
                hw_model: 4,
                role: 0
            })).finish();

            const envelopeBytes = ServiceEnvelope.encode(ServiceEnvelope.create({
                channel_id: 'MediumFast',
                gateway_id: '!gw_wire_broker',
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

            mockBroker.publish('msh/TW/2/e/MediumFast/!gw_wire_broker', Buffer.from(envelopeBytes));

            // 觸發子程序立即 Flush WriteQueue，等待 post-commit 日誌「👤 [節點資訊] 更新: WIR1」出現
            child.send({ type: 'TEST_FLUSH_DB_QUEUE', requestId: 'flush_wire_1' });
            await nodeInfoCommittedPromise;

            // 觸發正常 Shutdown
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
            assert.equal(exitResult.code, 0, `index.js 正常關閉應以 exit code 0 結束`);
            assert.match(stdoutLog, /\[SHUTDOWN\] 隊列資料已全數安全寫入並排空/);
            assert.match(stdoutLog, /\[SHUTDOWN\] WAL 檔案已安全截斷並回寫主資料庫/);
            assert.match(stdoutLog, /\[SHUTDOWN\] SQLite 連線已安全關閉/);
            child = null;

            const verifyDb = await createDatabaseSubsystem({ dbPath, bootstrapSchema: false });
            try {
                const nodeRow = await verifyDb.get('SELECT * FROM nodes WHERE node_id = ?', ['!abcd1234']);
                assert.ok(nodeRow, '透過本機 Broker Wire-Level PUBLISH 發送的 NODEINFO 封包應原子寫入 nodes 表');
                assert.equal(nodeRow.long_name, 'WireLevelBrokerNode');
                assert.equal(nodeRow.short_name, 'WIR1');

                const logRows = await verifyDb.all('SELECT * FROM packet_logs WHERE node_id = ?', ['!abcd1234']);
                assert.equal(logRows.length, 1, '應在同一交易將封包寫入 packet_logs 表');
                assert.equal(logRows[0].gateway_id, '!gw_wire_broker');
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

    // =========================================================================
    // 17. Schema Bootstrap 失敗阻擋 index.js 啟動測試 (Scope 3.2)
    // =========================================================================
    it('Test 4.0.2-17 — Schema Bootstrap Failure Blocks Service Startup: 當 Schema Index 驗證失敗時，index.js 不會提前啟動 HTTP 或 MQTT 服務並以非 0 狀態碼退出', async () => {
        const dbPath = createTempPath('index_boot_fail');
        const eventLogPath = createTempPath('index_fail_events', '.json');
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        const httpPort = await getFreeTcpPort();
        const appEntryPath = path.resolve(__dirname, '..', '..', 'index.js');

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
                    MQTT_PIPE_PATH: mockBroker.pipePath,
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

    // =========================================================================
    // 18 ~ 24. MQTT Mock Broker Stream Parser 拆包、黏包、多連線隔離與異常保護測試 (Section 四 Tests A ~ G)
    // =========================================================================
    function connectRawBrokerClient(mockBroker) {
        return new Promise((resolve, reject) => {
            const clientSocket = mockBroker.pipePath
                ? net.createConnection(mockBroker.pipePath)
                : net.createConnection({ host: '127.0.0.1', port: mockBroker.port });
            clientSocket.once('connect', () => resolve(clientSocket));
            clientSocket.once('error', reject);
        });
    }

    it('Test 4.0.2-18 — MQTT Mock Broker Stream Parser Test A (Complete Packet Single Arrival): 正常 MQTT PUBLISH 封包單次完整到達時正確解析', async () => {
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        let client = null;
        try {
            client = await connectRawBrokerClient(mockBroker);
            const topic = 'msh/TW/2/e/MediumFast/!gw_test_a';
            const payload = Buffer.from('SINGLE_ARRIVAL_PAYLOAD_OK', 'utf8');
            const pkt = buildMqttPublishPacket(topic, payload, 4);

            client.write(pkt);
            const publishes = await mockBroker.waitForPublishCount(1);
            assert.equal(publishes.length, 1);
            assert.equal(publishes[0].topic, topic);
            assert.deepEqual(publishes[0].payload, payload);
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 0, '解析完成後 receiveBuffer 應清空為 0');
        } finally {
            if (client && !client.destroyed) client.destroy();
            await mockBroker.close();
        }
    });

    it('Test 4.0.2-19 — MQTT Mock Broker Stream Parser Test B (Split Fixed Header): 將 MQTT Fixed Header 拆成不同 chunks 傳送，確認不會提前解析且收齊後完整還原', async () => {
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        let client = null;
        try {
            client = await connectRawBrokerClient(mockBroker);
            const topic = 'msh/TW/2/e/MediumFast/!gw_test_b';
            const payload = Buffer.from('SPLIT_FIXED_HEADER_PAYLOAD', 'utf8');
            const pkt = buildMqttPublishPacket(topic, payload, 4);

            // Chunk 1: 只送 Fixed Header 第一個 byte (0x30)，連 Remaining Length 都還沒到
            client.write(pkt.subarray(0, 1));
            await new Promise((r) => setTimeout(r, 25));
            assert.equal(mockBroker.receivedPublishes.length, 0, 'Fixed Header 不完整時絕不可提前解析');
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 1, '第 1 個 byte 必須保留在該 Socket 的 receiveBuffer 中');

            // Chunk 2: 送出剩餘 bytes
            client.write(pkt.subarray(1));
            const publishes = await mockBroker.waitForPublishCount(1);
            assert.equal(publishes.length, 1);
            assert.equal(publishes[0].topic, topic);
            assert.deepEqual(publishes[0].payload, payload);
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 0);
        } finally {
            if (client && !client.destroyed) client.destroy();
            await mockBroker.close();
        }
    });

    it('Test 4.0.2-20 — MQTT Mock Broker Stream Parser Test C (Split Multi-Byte Remaining Length): 將多 byte (2-byte 與 3-byte) Remaining Length 編碼拆成多次傳輸，確認正確累積與解析', async () => {
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        let client = null;
        try {
            client = await connectRawBrokerClient(mockBroker);
            const topic = 'msh/TW/2/e/MediumFast/!gw_test_c';
            // 建立 > 16384 bytes (約 18KB) 的 Payload，強制觸發 3-byte MQTT Remaining Length 編碼
            const largePayload = Buffer.alloc(18000, 0x5a);
            const pkt = buildMqttPublishPacket(topic, largePayload, 4);

            // pkt[0] = 0x30, pkt[1..3] = 3-byte Remaining Length (pkt[1] 與 pkt[2] 的最高位 bit 7 皆為 1)
            assert.ok((pkt[1] & 0x80) !== 0 && (pkt[2] & 0x80) !== 0 && (pkt[3] & 0x80) === 0, '必須為 3-byte Remaining Length');

            // 分別逐 byte 傳送 Fixed Header + Remaining Length 的前 2 個 byte
            client.write(pkt.subarray(0, 2)); // 0x30 + remLen byte 1
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(mockBroker.receivedPublishes.length, 0, 'Remaining Length 第 1 byte 尚未結束時不得提前解析');

            client.write(pkt.subarray(2, 3)); // remLen byte 2 (仍有 continuation bit)
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(mockBroker.receivedPublishes.length, 0, 'Remaining Length 第 2 byte 尚未結束時不得提前解析');

            client.write(pkt.subarray(3, 4)); // remLen byte 3 (完成 Remaining Length，但 Body 尚未到)
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(mockBroker.receivedPublishes.length, 0, 'Body 尚未到達時不得提前解析');
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 4);

            // 傳送剩餘 Body
            client.write(pkt.subarray(4));
            const publishes = await mockBroker.waitForPublishCount(1);
            assert.equal(publishes.length, 1);
            assert.equal(publishes[0].topic, topic);
            assert.equal(publishes[0].payload.length, largePayload.length);
            assert.deepEqual(publishes[0].payload, largePayload);
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 0);
        } finally {
            if (client && !client.destroyed) client.destroy();
            await mockBroker.close();
        }
    });

    it('Test 4.0.2-21 — MQTT Mock Broker Stream Parser Test D (Split Payload Across Chunks): 先傳送 Header 與部分 Payload，再分批傳送剩餘 Payload，確認最終訊息正確', async () => {
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        let client = null;
        try {
            client = await connectRawBrokerClient(mockBroker);
            const topic = 'msh/TW/2/e/MediumFast/!gw_test_d';
            const payload = Buffer.from('CHUNK_1_DATA::CHUNK_2_DATA::CHUNK_3_FINAL_PAYLOAD', 'utf8');
            const pkt = buildMqttPublishPacket(topic, payload, 4);

            const cut1 = 8; // Header + 部分 Topic
            const cut2 = Math.floor(pkt.length * 0.5);
            const cut3 = Math.floor(pkt.length * 0.8);

            client.write(pkt.subarray(0, cut1));
            await new Promise((r) => setTimeout(r, 15));
            assert.equal(mockBroker.receivedPublishes.length, 0);

            client.write(pkt.subarray(cut1, cut2));
            await new Promise((r) => setTimeout(r, 15));
            assert.equal(mockBroker.receivedPublishes.length, 0);

            client.write(pkt.subarray(cut2, cut3));
            await new Promise((r) => setTimeout(r, 15));
            assert.equal(mockBroker.receivedPublishes.length, 0);

            client.write(pkt.subarray(cut3));
            const publishes = await mockBroker.waitForPublishCount(1);
            assert.equal(publishes.length, 1);
            assert.equal(publishes[0].topic, topic);
            assert.deepEqual(publishes[0].payload, payload);
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 0);
        } finally {
            if (client && !client.destroyed) client.destroy();
            await mockBroker.close();
        }
    });

    it('Test 4.0.2-22 — MQTT Mock Broker Stream Parser Test E (Multiple Complete Packets Coalesced): 一次傳送三個合併到達的完整 MQTT 封包，確認依序解析全部訊息', async () => {
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        let client = null;
        try {
            client = await connectRawBrokerClient(mockBroker);
            const pkt1 = buildMqttPublishPacket('msh/TW/pkt1', Buffer.from('PAYLOAD_ONE', 'utf8'), 4);
            const pkt2 = buildMqttPublishPacket('msh/TW/pkt2', Buffer.from('PAYLOAD_TWO', 'utf8'), 4);
            const pkt3 = buildMqttPublishPacket('msh/TW/pkt3', Buffer.from('PAYLOAD_THREE', 'utf8'), 4);

            // 將 3 個完整 MQTT PUBLISH 封包合併為單一 Buffer 一次寫入
            client.write(Buffer.concat([pkt1, pkt2, pkt3]));
            const publishes = await mockBroker.waitForPublishCount(3);
            assert.equal(publishes.length, 3);
            assert.deepEqual(publishes.map((p) => p.topic), ['msh/TW/pkt1', 'msh/TW/pkt2', 'msh/TW/pkt3']);
            assert.deepEqual(
                publishes.map((p) => p.payload.toString('utf8')),
                ['PAYLOAD_ONE', 'PAYLOAD_TWO', 'PAYLOAD_THREE']
            );
            assert.equal(mockBroker.getSocketBufferLengths()[0].bufferedBytes, 0);
        } finally {
            if (client && !client.destroyed) client.destroy();
            await mockBroker.close();
        }
    });

    it('Test 4.0.2-23 — MQTT Mock Broker Stream Parser Test F (Complete Packet + Trailing Incomplete Packet, Multi-Socket Isolation & Close Cleanup): 驗證完整封包加半筆未完成封包、不同 Socket 緩衝隔離與關閉清理', async () => {
        const mockBroker = await startLocalMockMqttBroker({ usePipe: true });
        let client1 = null;
        let client2 = null;
        try {
            client1 = await connectRawBrokerClient(mockBroker);
            client2 = await connectRawBrokerClient(mockBroker);

            const pkt1 = buildMqttPublishPacket('msh/TW/s1/first', Buffer.from('S1_FIRST_COMPLETE', 'utf8'), 4);
            const pkt2 = buildMqttPublishPacket('msh/TW/s1/second', Buffer.from('S1_SECOND_SPLIT_ACROSS_CHUNKS', 'utf8'), 4);
            const pkt2Half = Math.floor(pkt2.length / 2);

            // Client 1 一次傳送：完整 pkt1 + 半個 pkt2
            client1.write(Buffer.concat([pkt1, pkt2.subarray(0, pkt2Half)]));
            await mockBroker.waitForPublishCount(1);

            assert.equal(mockBroker.receivedPublishes.length, 1, '已完成的第一筆封包應立即被解析');
            assert.equal(mockBroker.receivedPublishes[0].topic, 'msh/TW/s1/first');

            // 檢查 Client 1 的 receiveBuffer 精確保留 pkt2 前半段，且 Client 2 的 receiveBuffer 為 0
            const bufStatesMid = mockBroker.getSocketBufferLengths();
            assert.equal(bufStatesMid.length, 2, '應有 2 個獨立的 Socket 緩衝狀態');
            const s1State = bufStatesMid.find((s) => s.bufferedBytes > 0);
            const s2State = bufStatesMid.find((s) => s.bufferedBytes === 0);
            assert.ok(s1State, 'Client 1 必須保留未完成封包之剩餘 bytes');
            assert.equal(s1State.bufferedBytes, pkt2Half);
            assert.ok(s2State, 'Client 2 的 receiveBuffer 必須完全獨立為 0');

            // 此時 Client 2 傳送自己的完整封包，不得與 Client 1 的半包混在一起
            const pktClient2 = buildMqttPublishPacket('msh/TW/s2/independent', Buffer.from('CLIENT2_ISOLATED_MSG', 'utf8'), 4);
            client2.write(pktClient2);
            await mockBroker.waitForPublishCount(2);
            assert.equal(mockBroker.receivedPublishes[1].topic, 'msh/TW/s2/independent');
            assert.equal(mockBroker.receivedPublishes[1].payload.toString('utf8'), 'CLIENT2_ISOLATED_MSG');

            // Client 1 傳送 pkt2 後半段，完成解析
            client1.write(pkt2.subarray(pkt2Half));
            await mockBroker.waitForPublishCount(3);
            assert.equal(mockBroker.receivedPublishes[2].topic, 'msh/TW/s1/second');
            assert.equal(mockBroker.receivedPublishes[2].payload.toString('utf8'), 'S1_SECOND_SPLIT_ACROSS_CHUNKS');

            // 關閉 Client 1 與 Client 2，驗證連線關閉時清理對應 Socket 的緩衝狀態
            client1.destroy();
            client2.destroy();
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(mockBroker.getActiveSocketCount(), 0, 'Socket 關閉後必須清理所有對應緩衝狀態');
        } finally {
            if (client1 && !client1.destroyed) client1.destroy();
            if (client2 && !client2.destroyed) client2.destroy();
            await mockBroker.close();
        }
    });

    it('Test 4.0.2-24 — MQTT Mock Broker Stream Parser Test G (Abnormal Remaining Length & Buffer Size Limit Protection): 驗證異常 5-byte Remaining Length 與超限封包會受到保護並清理緩衝', async () => {
        const mockBroker = await startLocalMockMqttBroker({
            usePipe: true,
            maxRemainingLength: 1024, // 限制最大 Remaining Length 為 1KB
            maxBufferSize: 1536       // 限制單一 Socket 最大緩衝區為 1.5KB
        });
        let badClient1 = null;
        let badClient2 = null;
        let badClient3 = null;
        let goodClient = null;
        try {
            // Case G-1: 超過 MQTT 標準 4-byte 上限的非法 Remaining Length (連續 5 個 continuation bit=1 的 bytes)
            badClient1 = await connectRawBrokerClient(mockBroker);
            badClient1.write(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x80, 0x01]));
            await new Promise((r) => setTimeout(r, 30));
            assert.ok(
                mockBroker.protocolErrors.some((e) => e.reason === 'MALFORMED_REMAINING_LENGTH_VARINT'),
                '必須攔截並記錄超過 4 bytes 的非法 Remaining Length 編碼'
            );

            // Case G-2: 合法 varint 但宣告的 Remaining Length (例如 4096 bytes) 超出 Broker 設定上限 (1024 bytes)
            badClient2 = await connectRawBrokerClient(mockBroker);
            const declared4KBHeader = Buffer.concat([
                Buffer.from([0x30]),
                encodeMqttRemainingLength(4096),
                Buffer.from([0x00, 0x04, 0x74, 0x65, 0x73, 0x74])
            ]);
            badClient2.write(declared4KBHeader);
            await new Promise((r) => setTimeout(r, 30));
            assert.ok(
                mockBroker.protocolErrors.some((e) => e.reason === 'REMAINING_LENGTH_EXCEEDS_LIMIT'),
                '必須攔截並記錄超出 maxRemainingLength 的封包'
            );

            // Case G-3: 持續傳送超出 maxBufferSize 的大量不完整資料
            badClient3 = await connectRawBrokerClient(mockBroker);
            badClient3.write(Buffer.alloc(2048, 0xaa));
            await new Promise((r) => setTimeout(r, 30));
            assert.ok(
                mockBroker.protocolErrors.some((e) => e.reason === 'MAX_BUFFER_SIZE_EXCEEDED'),
                '必須攔截並記錄超出 maxBufferSize 的緩衝區溢位嘗試'
            );

            // 確認異常連線皆已被關閉並釋放緩衝區，且不影響後續正常 Client 運作
            assert.equal(mockBroker.getActiveSocketCount(), 0, '異常 Socket 關閉後緩衝狀態應全數釋放');

            goodClient = await connectRawBrokerClient(mockBroker);
            const validPkt = buildMqttPublishPacket('msh/TW/good', Buffer.from('STILL_HEALTHY', 'utf8'), 4);
            goodClient.write(validPkt);
            const publishes = await mockBroker.waitForPublishCount(1);
            assert.equal(publishes.length, 1);
            assert.equal(publishes[0].topic, 'msh/TW/good');
            assert.equal(publishes[0].payload.toString('utf8'), 'STILL_HEALTHY');
        } finally {
            for (const c of [badClient1, badClient2, badClient3, goodClient]) {
                if (c && !c.destroyed) c.destroy();
            }
            await mockBroker.close();
        }
    });
});
