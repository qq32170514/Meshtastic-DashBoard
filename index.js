const mqtt = require('mqtt');
const protobuf = require('protobufjs');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
app.use(express.static(__dirname)); // 允許存取同目錄下的靜態檔案

// ==========================================
// 1. 初始化 SQLite 資料庫
// ==========================================
const db = new sqlite3.Database('./meshtastic.db', (err) => {
    if (err) console.error('❌ 資料庫連線失敗:', err.message);
    else console.log('🗄️ SQLite 資料庫連線成功！');
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
            air_util_tx REAL
        )
    `);
    // 新增 nodes 資料表，用於追蹤所有出現過的節點及其最後在線時間
    db.run(`
        CREATE TABLE IF NOT EXISTS nodes (
            node_id TEXT PRIMARY KEY,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    // 建立索引以加速前端查詢歷史數據的效能
    db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_data (timestamp)`);
});

// ==========================================
// 1.2 資料清理任務 (保留 3 天)
// ==========================================
function cleanupOldData() {
    const sql = `DELETE FROM telemetry_data WHERE timestamp < datetime('now', '-3 days')`;
    db.run(sql, function(err) {
        if (err) console.error('❌ 清理舊資料失敗:', err.message);
        else if (this.changes > 0) {
            console.log(`🧹 自動清理完成，已刪除 ${this.changes} 筆超過 3 天的舊資料`);
        }
    });
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
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 取得目前所有已知的節點清單
app.get('/api/nodes', (req, res) => {
    db.all(`SELECT node_id FROM nodes ORDER BY node_id ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => row.node_id));
    });
});

// 取得所有節點的詳細在線狀態
app.get('/api/node-status', (req, res) => {
    db.all(`SELECT * FROM nodes ORDER BY last_seen DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
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

let ServiceEnvelope, Telemetry;

root.load([
    "meshtastic/mqtt.proto", 
    "meshtastic/telemetry.proto",
    "meshtastic/portnums.proto"
], { keepCase: true }, (err) => {
    if (err) {
        console.error('❌ Protobuf 字典載入失敗:', err);
        return;
    }
    ServiceEnvelope = root.lookupType("meshtastic.ServiceEnvelope");
    Telemetry = root.lookupType("meshtastic.Telemetry");
    console.log('📚 Protobuf 字典載入完成！準備啟動雷達...');
    startMqtt();
});

// ==========================================
// 3. 啟動 MQTT 監聽與資料寫入
// ==========================================
function startMqtt() {
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
        // Debug: 在控制台印出所有收到的 Topic，確認過濾器是否有抓到東西
        // console.log(`📩 收到 Topic: ${topic}`);

        try {
            const envelope = ServiceEnvelope.decode(message);
            if (!envelope.packet || !envelope.packet.decoded) return;
            
            const packet = envelope.packet;
            const decodedData = packet.decoded;
            const fromId = `!${packet.from.toString(16).padStart(8, '0')}`;

            // 在 Terminal 顯示收到的封包摘要
            console.log(`📦 [收到封包] 來自: ${fromId} | Port: ${decodedData.portnum} | Topic: ${topic}`);
            
            // 更新節點最後在線時間 (不論是否為遙測封包)
            db.run(`REPLACE INTO nodes (node_id, last_seen) VALUES (?, CURRENT_TIMESTAMP)`, [fromId], (err) => {
                if (!err) {
                    // 透過 WebSocket 通知前端更新節點列表
                    io.emit('node_seen', { node_id: fromId, last_seen: new Date().toISOString() });
                }
            });

            // 推播原始封包資訊到前端日誌視窗
            io.emit('raw_packet', {
                from: fromId,
                portnum: decodedData.portnum,
                topic: topic,
                time: new Date().toLocaleTimeString()
            });

            if (decodedData.portnum === 67 || decodedData.portnum === 'TELEMETRY_APP') {
                const telemetry = Telemetry.decode(decodedData.payload);
                const cleanJSON = Telemetry.toObject(telemetry, { enums: String, defaults: true });
                
                const device = cleanJSON.device_metrics || cleanJSON.deviceMetrics || {};
                const env = cleanJSON.environment_metrics || cleanJSON.environmentMetrics || {};
                
                if (Object.keys(device).length > 0 || Object.keys(env).length > 0) {
                    const sql = `
                        INSERT INTO telemetry_data 
                        (node_id, battery_level, voltage, temperature, humidity, channel_utilization, air_util_tx) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `;
                    const params = [
                        fromId, 
                        device.battery_level ?? device.batteryLevel ?? null, 
                        device.voltage ?? null, 
                        env.temperature ?? null, 
                        env.relative_humidity ?? env.relativeHumidity ?? null, 
                        device.channel_utilization ?? device.channelUtilization ?? null, 
                        device.air_util_tx ?? device.airUtilTx ?? null
                    ];

                    db.run(sql, params, function(err) {
                        if (err) return console.error('❌ 寫入資料庫失敗:', err.message);
                        
                        console.log(`💾 [寫入DB成功] 節點: ${fromId} | 紀錄 ID: ${this.lastID}`);
                        // 透過 WebSocket 即時推播新資料到前端
                        io.emit('telemetry_update', {
                            node_id: fromId,
                            battery_level: params[1],
                            temperature: params[3],
                            humidity: params[4],
                            timestamp: new Date().toISOString()
                        });
                    });
                }
            } 
        } catch (err) {
            // 忽略無法解碼的雜訊封包
        }
    });
}