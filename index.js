const mqtt = require('mqtt');
const protobuf = require('protobufjs');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const seenPackets = new Set(); // 🛑 用於攔截 MQTT 重複封包的快取

let isMqttConnected = false; // 紀錄 MQTT 連線狀態

// ==========================================
// Socket.io 連線監聽 (新增)
// ==========================================
io.on('connection', (socket) => {
    console.log('🔌 有新用戶連線到 Dashboard:', socket.id);
    // 當用戶剛連線時，立即告知當前的 MQTT 狀態
    socket.emit('mqtt_status', { connected: isMqttConnected });
    socket.on('disconnect', () => console.log('❌ 用戶已中斷連線'));
});

// 捕捉全域未處理錯誤，防止程式無預警結束
process.on('uncaughtException', (err) => {
    console.error('💥 偵測到未捕獲的異常 (Uncaught Exception):', err);
});

// 你的專屬節點 ID
const myNodeId = '!7931b961'; 

// 靜態檔案路徑：優先服務前端編譯出的 dist 夾，若無則服務目前目錄（相容舊 index.html）
app.use(express.static(path.join(__dirname, 'frontend/dist')));
app.use(express.static(__dirname));

// ==========================================
// 1. 初始化 SQLite 資料庫
// ==========================================
const dbPath = path.join(__dirname, 'meshtastic.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('❌ 資料庫連線失敗:', err.message);
    else console.log(`🗄️ SQLite 資料庫已連線至: ${dbPath}`);
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS telemetry_data (
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
            current REAL,
            hop_limit INTEGER,
            hop_start INTEGER
        )
    `);
    // 新增 nodes 資料表，用於追蹤所有出現過的節點及其最後在線時間
    db.run(`
        CREATE TABLE IF NOT EXISTS nodes (
            node_id TEXT PRIMARY KEY,
            long_name TEXT,
            short_name TEXT,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            latitude REAL,
            longitude REAL,
            is_favorite INTEGER DEFAULT 0,
            last_topic TEXT,
            hop_limit INTEGER,
            hop_start INTEGER,
            role TEXT,
            channel TEXT,
            hw_model TEXT
        )
    `);
    // 新增 packet_logs 資料表，紀錄所有原始封包軌跡
    db.run(`
        CREATE TABLE IF NOT EXISTS packet_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            portnum TEXT,
            topic TEXT,
            gateway_id TEXT,
            snr REAL,
            rssi REAL,
            hop_limit INTEGER,
            hop_start INTEGER,
            payload_json TEXT,
            raw_hex TEXT
        )
    `);
    // 新增 chat_messages 資料表，專門儲存解密後的文字訊息
    db.run(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            message TEXT,
            channel_name TEXT
        )
    `);
    // 確保舊資料庫也能加上欄位 (如果已存在則會忽略錯誤)
    db.run(`ALTER TABLE nodes ADD COLUMN is_favorite INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE nodes ADD COLUMN last_topic TEXT`, (err) => {});
    db.run(`ALTER TABLE packet_logs ADD COLUMN gateway_id TEXT`, (err) => {});
    db.run(`ALTER TABLE telemetry_data ADD COLUMN current REAL`, (err) => {});
    db.run(`ALTER TABLE packet_logs ADD COLUMN hop_limit INTEGER`, (err) => {});
    db.run(`ALTER TABLE packet_logs ADD COLUMN hop_start INTEGER`, (err) => {});
    db.run(`ALTER TABLE packet_logs ADD COLUMN payload_json TEXT`, (err) => {});
    db.run(`ALTER TABLE packet_logs ADD COLUMN raw_hex TEXT`, (err) => {});
    db.run(`ALTER TABLE nodes ADD COLUMN hop_limit INTEGER`, (err) => {});
    db.run(`ALTER TABLE nodes ADD COLUMN hop_start INTEGER`, (err) => {});
    db.run(`ALTER TABLE nodes ADD COLUMN role TEXT`, (err) => {});
    db.run(`ALTER TABLE nodes ADD COLUMN channel TEXT`, (err) => {});
    db.run(`ALTER TABLE nodes ADD COLUMN hw_model TEXT`, (err) => {});
    // 建立索引以加速前端查詢歷史數據的效能
    db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_data (timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_node_id ON packet_logs (node_id)`);
});

// ==========================================
// 1.2 資料清理任務 (保留 3 天)
// ==========================================
function cleanupOldData() {
    const sql = `DELETE FROM telemetry_data WHERE timestamp < datetime('now', '-3 days')`;
    const sqlPackets = `DELETE FROM packet_logs WHERE timestamp < datetime('now', '-3 days')`;
    // 新增：聊天紀錄保留 30 天，避免資料庫無限增長
    const sqlChat = `DELETE FROM chat_messages WHERE timestamp < datetime('now', '-30 days')`;

    db.run(sql, function(err) {
        if (err) console.error('❌ 清理舊資料失敗:', err.message);
        else if (this.changes > 0) {
            console.log(`🧹 自動清理完成，已刪除 ${this.changes} 筆超過 3 天的舊資料`);
        }
    });
    db.run(sqlPackets);
    db.run(sqlChat);
}

// 每小時執行一次清理
setInterval(cleanupOldData, 60 * 60 * 1000);
cleanupOldData(); // 啟動時先執行一次

// ==========================================
// 1.5 API 路由設定 (提供給前端)
// ==========================================

// 取得所有或特定節點的最新遙測資料
app.get('/api/telemetry', (req, res) => {
    const nodeId = req.query.node_id;
    const limit = parseInt(req.query.limit) || 50;

    let sql = `SELECT * FROM telemetry_data`;
    let params = [];

    if (nodeId) {
        sql += ` WHERE node_id = ?`;
        params.push(nodeId);
    }
    
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('❌ API /api/telemetry Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 取得目前所有已知的節點清單
app.get('/api/nodes', (req, res) => {
    db.all(`SELECT node_id FROM nodes ORDER BY node_id ASC`, [], (err, rows) => {
        if (err) {
            console.error('❌ API /api/nodes Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(row => row.node_id));
    });
});

// 取得所有節點的詳細在線狀態
app.get('/api/node-status', (req, res) => {
    db.all(`SELECT * FROM nodes ORDER BY last_seen DESC`, [], (err, rows) => {
        if (err) {
            console.error('❌ API /api/node-status Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 取得單一節點的詳細資訊
app.get('/api/node/:nodeId', (req, res) => {
    db.get(`SELECT * FROM nodes WHERE node_id = ?`, [req.params.nodeId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

// 取得全域最新封包紀錄 (提供給封包觀察分頁)
app.get('/api/packets', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const sql = `SELECT * FROM packet_logs ORDER BY timestamp DESC LIMIT ?`;
    db.all(sql, [limit], (err, rows) => {
        if (err) {
            console.error('❌ API /api/packets SQL Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 取得特定頻道的歷史對話紀錄 (翻閱功能)
app.get('/api/chat-history/:channel', (req, res) => {
    const channel = req.params.channel;
    const sql = `SELECT * FROM chat_messages WHERE channel_name = ? ORDER BY timestamp DESC LIMIT 100`;
    db.all(sql, [channel], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.reverse()); // 由舊到新排序回傳
    });
});

// 取得單一節點的歷史封包紀錄
app.get('/api/node/:nodeId/packets', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const sql = `SELECT * FROM packet_logs WHERE node_id = ? ORDER BY timestamp DESC LIMIT ?`;
    db.all(sql, [req.params.nodeId, limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 取得單一節點的閘道收信統計 (Received Gateways)
app.get('/api/node/:nodeId/gateways', (req, res) => {
    const sql = `
        SELECT gateway_id, COUNT(*) as count, MAX(timestamp) as last_seen, MAX(hop_start) as hop_start, MIN(hop_limit) as hop_limit
        FROM packet_logs 
        WHERE node_id = ? AND gateway_id IS NOT NULL AND gateway_id != ''
        GROUP BY gateway_id 
        ORDER BY count DESC`;
    db.all(sql, [req.params.nodeId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 取得單一節點的封包種類統計 (Packet Distribution)
app.get('/api/node/:nodeId/packet-stats', (req, res) => {
    const sql = `
        SELECT portnum, COUNT(*) as count, MAX(timestamp) as last_seen 
        FROM packet_logs 
        WHERE node_id = ?
        GROUP BY portnum 
        ORDER BY count DESC`;
    db.all(sql, [req.params.nodeId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 切換節點最愛狀態
app.post('/api/node/:nodeId/favorite', (req, res) => {
    const { is_favorite } = req.body;
    db.run(`UPDATE nodes SET is_favorite = ? WHERE node_id = ?`, [is_favorite ? 1 : 0, req.params.nodeId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, is_favorite: is_favorite });
    });
});

// 啟動 Express 伺服器
server.listen(PORT, () => {
    console.log(`🚀 API 伺服器已啟動: http://localhost:${PORT}`);
    console.log(`📊 嘗試存取資料: http://localhost:${PORT}/api/telemetry`);
});

// ==========================================
// 2. 設定 Protobuf 解析器
// ==========================================
const root = new protobuf.Root();
root.resolvePath = (origin, target) => __dirname + '/protobufs/' + target;

let ServiceEnvelope, Telemetry, User, Position, MapReport, Data, Routing, RouteDiscovery, NeighborInfo;

root.load([
    "meshtastic/mqtt.proto", 
    "meshtastic/telemetry.proto",
    "meshtastic/portnums.proto",
    "meshtastic/mesh.proto",
    "meshtastic/channel.proto",
    "meshtastic/config.proto"
], { keepCase: true }, (err) => {
    if (err) {
        console.error('❌ Protobuf 字典載入失敗:', err);
        return;
    }
    ServiceEnvelope = root.lookupType("meshtastic.ServiceEnvelope");
    Telemetry = root.lookupType("meshtastic.Telemetry");
    User = root.lookupType("meshtastic.User");
    Position = root.lookupType("meshtastic.Position");
    MapReport = root.lookupType("meshtastic.MapReport");
    Data = root.lookupType("meshtastic.Data");
    Routing = root.lookupType("meshtastic.Routing");
    RouteDiscovery = root.lookupType("meshtastic.RouteDiscovery");
    NeighborInfo = root.lookupType("meshtastic.NeighborInfo");
    console.log('📚 Protobuf 字典載入完成！準備啟動雷達...');
    startMqttClient(); // 修正為 startMqttClient
});

// ==========================================
// 3. 啟動 MQTT 監聽與資料寫入
// ==========================================
function startMqttClient() { // 修正函數名稱為 startMqttClient
    const client = mqtt.connect('mqtt://mqtt.meshtastic.org', {
        username: 'meshdev',
        password: 'large4cats',
        clientId: 'mesh_dash_' + Math.random().toString(16).substring(2, 10), 
        connectTimeout: 5000 
    });

    client.on('connect', () => {
        console.log('✅ 已成功連線到 MQTT 伺服器！');
        isMqttConnected = true;
        io.emit('mqtt_status', { connected: true });
        
        // 只訂閱台灣區域的 Topic (# 代表監聽 TW 路徑下的所有子頻道)
        const topics = ['msh/TW/#'];
        client.subscribe(topics, (err) => {
            if (!err) console.log(`📡 訂閱成功！正在監聽: ${topics.join(', ')}`);
        });
    });

    client.on('reconnect', () => {
        console.log('🔄 正在嘗試重新連線至 MQTT...');
    });

    client.on('offline', () => {
        console.log('📡 MQTT 目前處於離線狀態');
    });

    client.on('message', (topic, message) => {
        const rawHex = message.toString('hex').toUpperCase();

        try {
            const envelope = ServiceEnvelope.decode(message);
            if (!envelope.packet) return;
            
            const packet = envelope.packet;
            const fromId = `!${packet.from.toString(16).padStart(8, '0')}`;
            const gatewayId = envelope.gateway_id || 'Unknown';

            // 🛑 封包去重過濾器：檢查「發送者 + 封包ID」
            const packetKey = `${fromId}-${packet.id}`;
            if (seenPackets.has(packetKey)) return; 
            
            seenPackets.add(packetKey);
            
            // 自動清理快取：保留最近 1000 個封包 ID，避免記憶體洩漏
            if (seenPackets.size > 1000) {
                const iter = seenPackets.values();
                seenPackets.delete(iter.next().value);
            }

            // 解析頻道名稱：優先尋找 /c/ 標籤，若無則過濾保留字
            const topicParts = topic.split('/');
            const cIndex = topicParts.indexOf('c');
            const jsonIndex = topicParts.indexOf('json');
            let resolvedChannel = (cIndex !== -1 && topicParts[cIndex + 1]) ? topicParts[cIndex + 1] : (jsonIndex !== -1 ? topicParts[jsonIndex + 1] : null);
            if (!resolvedChannel) {
                resolvedChannel = topicParts.find(p => 
                    !/^\d+$/.test(p) && !['msh', 'TW', 'c', 'json', 'e', 'stat'].includes(p) && !p.startsWith('!') && p !== ''
                ) || null;
            }

            let decodedData = packet.decoded;

            // ==========================================
            // 🔥 1. 多頻道神級解密引擎 🔥
            // ==========================================
            if (!decodedData && packet.encrypted && packet.encrypted.length > 0) {
                
                // 🛡️ 安全過濾：將 Base64URL 轉為標準 Base64，避免金鑰破損
                const safeBase64 = (str) => str.replace(/-/g, '+').replace(/_/g, '/');

                const knownKeys = [
                    { name: "MediumFast", key: Buffer.from("1PG7OiApB1nwvP+rz05pAQ==", "base64") },
                    { name: "MeshTW", key: Buffer.from(safeBase64("isDhHrNpJPlGX3GBJBX6kjuK7KQNp4Z0M7OTDpnX5N4"), "base64") },
                    { name: "SignalTest", key: Buffer.from(safeBase64("y1HciVgpl5Hzh05KJUe/umWUH8XhG3UjR1rvZHfUHFU="), "base64") },
                    { name: "Emergency!", key: Buffer.from(safeBase64("isDhHrNpJPlGX3GBJBX6kjuK7KQNp4Z0M7OTDpnX5N4"), "base64") }
                ];

                try {
                    // Nonce 構造：必須遵守硬體層 64-bit 記憶體對齊
                    const iv = Buffer.alloc(16);
                    iv.writeUInt32LE(packet.id >>> 0, 0);
                    iv.writeUInt32LE(packet.from >>> 0, 8); // 👉 關鍵修正：From ID 必須在 Offset 8
                    
                    for (const k of knownKeys) {
                        try {
                            if (k.key.length !== 16 && k.key.length !== 32) continue;

                            const algo = k.key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
                            const decipher = crypto.createDecipheriv(algo, k.key, iv);
                            const decrypted = Buffer.concat([decipher.update(packet.encrypted), decipher.final()]);
                            
                            const attempt = Data.decode(decrypted);
                            const port = attempt.portnum;
                            
                            // 🛑 破除「假成功」陷阱：過濾掉拿錯鑰匙產生的亂碼
                            if (port === 0 || port === 'UNKNOWN_APP' || port === undefined) {
                                continue; 
                            }

                            // 🎯 成功解密！
                            decodedData = attempt;
                            
                            // 核心優化：優先使用解密後確認的頻道名稱
                            decodedData.channel_name = resolvedChannel || k.name;
                            
                            break; 
                        } catch (e) { /* 此金鑰失敗，繼續 */ }
                    }
                } catch (e) { console.error('❌ 解密引擎結構錯誤', e); }
            }

            // 1. 更新節點最後在線狀態 (Discovery)
            const nodeUpdateSql = `
                INSERT INTO nodes (node_id, last_seen, last_topic, channel, hop_limit, hop_start) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET last_seen=excluded.last_seen, last_topic=excluded.last_topic, channel=COALESCE(excluded.channel, nodes.channel), hop_limit=excluded.hop_limit, hop_start=excluded.hop_start
            `;
            db.run(nodeUpdateSql, [fromId, topic, resolvedChannel, packet.hop_limit || 0, packet.hop_start || 0]);
            io.emit('node_seen', { node_id: fromId, last_seen: new Date().toISOString(), last_topic: topic, channel: resolvedChannel });

            // 2. 如果最終仍無法解碼，則標記為 ENCRYPTED
            if (!decodedData) {
                db.run(`INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                    [fromId, 'ENCRYPTED', topic, gatewayId, packet.rx_snr || null, packet.rx_rssi || null, packet.hop_limit || 0, packet.hop_start || 0, null, rawHex]);
                io.emit('raw_packet', { 
                    from: fromId, 
                    portnum: 'ENCRYPTED', 
                    topic: topic, 
                    gateway_id: gatewayId, 
                    timestamp: new Date().toISOString(),
                    time: new Date().toLocaleTimeString(), 
                    snr: packet.rx_snr, 
                    rssi: packet.rx_rssi, 
                    rawData: rawHex 
                });
                return;
            }

            // ==========================================
            // 💬 3. 業務邏輯解析 (文字、遙測等)
            // ==========================================
            let payloadObj = null;
            const port = decodedData.portnum;
            const payloadBuffer = Buffer.isBuffer(decodedData.payload) ? decodedData.payload : Buffer.from(decodedData.payload || []);

            try {
                if (port === 1 || port === 'TEXT_MESSAGE_APP') {
                    const textMessage = payloadBuffer.toString('utf8');
                    const channelName = decodedData.channel_name || 'MediumFast';
                    payloadObj = { text: textMessage, channel_name: channelName };
                    
                    console.log(`💬 [頻道: ${channelName}] ${fromId} 說: ${textMessage}`);
                    
                    // 寫入聊天紀錄表
                    db.run(`INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)`, [fromId, textMessage, channelName]);
                } else if (port === 3 || port === 'POSITION_APP') {
                    payloadObj = Position.toObject(Position.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 4 || port === 'NODEINFO_APP') {
                    payloadObj = User.toObject(User.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 5 || port === 'ROUTING_APP') {
                    payloadObj = Routing.toObject(Routing.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 67 || port === 'TELEMETRY_APP') {
                    payloadObj = Telemetry.toObject(Telemetry.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 70 || port === 'TRACEROUTE_APP') {
                    payloadObj = RouteDiscovery.toObject(RouteDiscovery.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 71 || port === 'NEIGHBORINFO_APP') {
                    payloadObj = NeighborInfo.toObject(NeighborInfo.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 73 || port === 'MAP_REPORT_APP') {
                    payloadObj = MapReport.toObject(MapReport.decode(payloadBuffer), { enums: String, defaults: true });
                }
            } catch (e) { console.error('❌ Payload 解析失敗', e); }
            
            if (payloadObj && decodedData.channel_name) {
                payloadObj.channel_name = decodedData.channel_name;
            }

            // 3. 寫入封包日誌並推播
            const payloadJson = payloadObj ? JSON.stringify(payloadObj) : null;
            db.run(`INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [fromId, port, topic, gatewayId, packet.rx_snr || null, packet.rx_rssi || null, packet.hop_limit || 0, packet.hop_start || 0, payloadJson, rawHex]);

            io.emit('raw_packet', { 
                from: fromId, 
                portnum: port, 
                topic: topic, 
                gateway_id: gatewayId, 
                timestamp: new Date().toISOString(),
                time: new Date().toLocaleTimeString(), 
                snr: packet.rx_snr, 
                rssi: packet.rx_rssi, 
                payload_json: payloadObj, 
                rawData: rawHex 
            });

            // 解析節點資訊 (名稱)
            if (port === 4 || port === 'NODEINFO_APP') {
                try {
                    const user = User.toObject(User.decode(payloadBuffer), { enums: String });
                    const finalRole = user.role || 'CLIENT';
                    const hwModel = user.hw_model || user.hwModel || null;
                    db.run(`
                        UPDATE nodes SET long_name = ?, short_name = ?, role = ?, hw_model = ? WHERE node_id = ?
                    `, [user.long_name, user.short_name, finalRole, hwModel, fromId], (err) => {
                        if (!err) {
                            console.log(`👤 [節點資訊] 更新: ${user.short_name} 角色: ${finalRole}`);
                            io.emit('node_seen', { 
                                node_id: fromId, 
                                long_name: user.long_name, 
                                short_name: user.short_name,
                                role: finalRole,
                                hw_model: hwModel,
                                last_seen: new Date().toISOString(),
                                last_topic: topic
                            });
                        }
                    });
                } catch (e) { console.error('❌ 解析 NodeInfo 失敗', e); }
            }

            // 解析位置資訊 (經緯度)
            if (port === 3 || port === 'POSITION_APP') {
                try {
                    const pos = Position.decode(decodedData.payload);
                    if (pos.latitude_i && pos.longitude_i) {
                        const lat = pos.latitude_i / 1e7;
                        const lng = pos.longitude_i / 1e7;
                        db.run(`UPDATE nodes SET latitude = ?, longitude = ? WHERE node_id = ?`, [lat, lng, fromId], (err) => {
                            if (!err) {
                                console.log(`📍 [位置更新] 節點: ${fromId} -> ${lat}, ${lng}`);
                                io.emit('node_seen', { 
                                    node_id: fromId, 
                                    latitude: lat, 
                                    longitude: lng, 
                                    last_seen: new Date().toISOString(),
                                    last_topic: topic
                                });
                            }
                        });
                    }
                } catch (e) { console.error('❌ 解析 Position 失敗', e); }
            }

            // 解析 MapReport (包含名稱與位置)
            if (port === 73 || port === 'MAP_REPORT_APP') {
                try {
                    const report = MapReport.decode(decodedData.payload);
                    const lat = report.latitude_i / 1e7;
                    const lng = report.longitude_i / 1e7;
                    db.run(`
                        UPDATE nodes SET long_name = ?, short_name = ?, latitude = ?, longitude = ? WHERE node_id = ?
                    `, [report.long_name, report.short_name, lat, lng, fromId], (err) => {
                        if (!err) {
                            console.log(`🗺️ [地圖報告] 節點: ${report.short_name} -> ${lat}, ${lng}`);
                            io.emit('node_seen', { 
                                node_id: fromId, 
                                long_name: report.long_name, 
                                short_name: report.short_name,
                                latitude: lat,
                                longitude: lng,
                                last_seen: new Date().toISOString(),
                                last_topic: topic
                            });
                        }
                    });
                } catch (e) { console.error('❌ 解析 MapReport 失敗', e); }
            }

            if (port === 67 || port === 'TELEMETRY_APP') {
                const telemetry = Telemetry.decode(decodedData.payload);
                const cleanJSON = Telemetry.toObject(telemetry, { enums: String, defaults: true });
                
                const device = cleanJSON.device_metrics || cleanJSON.deviceMetrics || {};
                const env = cleanJSON.environment_metrics || cleanJSON.environmentMetrics || {};
                const power = cleanJSON.power_metrics || cleanJSON.powerMetrics || {};
                const air = cleanJSON.air_util_tx ?? device.air_util_tx ?? device.airUtilTx ?? null;
                const cu = device.channel_utilization ?? device.channelUtilization ?? null;

                // 優先權邏輯：I2C 電壓/電流 (Power Metrics) > ADC 設備電壓 (Device Metrics)
                const finalVoltage = power.ch1_voltage ?? power.ch1Voltage ?? device.voltage ?? null;
                const finalCurrent = power.ch1_current ?? power.ch1Current ?? null;

                const sql = `
                    INSERT INTO telemetry_data 
                    (node_id, battery_level, voltage, temperature, humidity, channel_utilization, air_util_tx, snr, rssi, current, hop_limit, hop_start) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;
                    const params = [
                        fromId, 
                        device.battery_level ?? device.batteryLevel ?? null, 
                        finalVoltage, 
                        env.temperature ?? null, 
                        env.relative_humidity ?? env.relativeHumidity ?? null, 
                        cu, 
                        air,
                        packet.rx_snr ?? null,
                        packet.rx_rssi ?? null,
                        finalCurrent,
                        packet.hop_limit || 0,
                        packet.hop_start || 0
                    ];
    
                    db.run(sql, params, function(err) {
                        if (err) return console.error('❌ 寫入資料庫失敗:', err.message);
    
                        console.log(`💾 [寫入DB成功] 節點: ${fromId} | 紀錄 ID: ${this.lastID}`);
                        // 透過 WebSocket 即時推播新資料到前端
                        io.emit('telemetry_update', {
                            node_id: fromId,
                            battery_level: params[1],
                            voltage: finalVoltage,
                            current: finalCurrent,
                            temperature: params[3],
                            humidity: params[4],
                            channel_utilization: cu,
                            air_util_tx: air,
                            timestamp: new Date().toISOString(),
                            snr: params[7],
                            rssi: params[8],
                            hop_limit: params[9],
                            hop_start: params[10]
                        });
                    });
            } 
        } catch (err) {
            // 忽略無法解碼的雜訊封包
        }
    });
}

// ==========================================
// 💾 4. 每 12 小時自動備份資料庫至雲端
// ==========================================
cron.schedule('0 */12 * * *', () => {
    // 原始資料庫路徑
    const sourceDbPath = path.join(__dirname, 'meshtastic.db');
    
    // 您指定的 Google Drive 同步資料夾路徑
    const googleDrivePath = 'D:\\雲端硬碟同步用\\Meshtastic_Backup'; 
    
    // 如果資料夾不存在，就自動建立
    if (!fs.existsSync(googleDrivePath)){
        fs.mkdirSync(googleDrivePath, { recursive: true });
    }

    // 取得今天的日期作為檔名後綴
    const dateStr = new Date().toISOString().slice(0, 10); 
    const backupFileName = `meshtastic_backup_${dateStr}.db`;
    const targetBackupPath = path.join(googleDrivePath, backupFileName);

    try {
        // 執行檔案複製 (靜態副本)
        fs.copyFileSync(sourceDbPath, targetBackupPath);
        console.log(`\n📦 [雲端備份成功] ${new Date().toLocaleString()} - 資料庫已安全複製至: ${backupFileName}`);
    } catch (err) {
        console.error('\n❌ [雲端備份失敗] 發生錯誤:', err);
    }
});