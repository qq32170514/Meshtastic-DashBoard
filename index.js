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

// ==========================================
// Socket.io 連線監聽 (新增)
// ==========================================
io.on('connection', (socket) => {
    console.log('🔌 有新用戶連線到 Dashboard:', socket.id);
    socket.on('disconnect', () => console.log('❌ 用戶已中斷連線'));
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
});

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
    db.all(`SELECT DISTINCT node_id FROM telemetry_data`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => row.node_id));
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
        client.subscribe(['msh/TW/+/c/+/+', 'msh/2/c/+/+'], (err) => {
            if (!err) console.log(`📡 正在監聽全台灣/全球頻道，等待封包降落...\n`);
        });
    });

    client.on('message', (topic, message) => {
        try {
            const envelope = ServiceEnvelope.decode(message);
            if (!envelope.packet || !envelope.packet.decoded) return;
            
            const packet = envelope.packet;
            const decodedData = packet.decoded;
            const fromId = `!${packet.from.toString(16).padStart(8, '0')}`;
            
            if (decodedData.portnum === 67 || decodedData.portnum === 'TELEMETRY_APP') {
                const telemetry = Telemetry.decode(decodedData.payload);
                const cleanJSON = Telemetry.toObject(telemetry, { enums: String, defaults: true });
                
                const device = cleanJSON.device_metrics || cleanJSON.deviceMetrics || {};
                const env = cleanJSON.environment_metrics || cleanJSON.environmentMetrics || {};
                
                if (Object.keys(device).length > 0 || Object.keys(env).length > 0) {
                    const stmt = db.prepare(`
                        INSERT INTO telemetry_data 
                        (node_id, battery_level, voltage, temperature, humidity, channel_utilization, air_util_tx) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `);
                    
                    stmt.run(
                        fromId, 
                        device.battery_level ?? device.batteryLevel ?? null, 
                        device.voltage ?? null, 
                        env.temperature ?? null, 
                        env.relative_humidity ?? env.relativeHumidity ?? null, 
                        device.channel_utilization ?? device.channelUtilization ?? null, 
                        device.air_util_tx ?? device.airUtilTx ?? null,
                        function(err) {
                            if (!err) {
                                console.log(`💾 [寫入DB成功] 節點: ${fromId} | 紀錄 ID: ${this.lastID}`);
                                // 透過 WebSocket 即時推播新資料到前端
                                io.emit('telemetry_update', {
                                    node_id: fromId,
                                    battery_level: device.battery_level ?? device.batteryLevel ?? null,
                                    temperature: env.temperature ?? null,
                                    humidity: env.relative_humidity ?? env.relativeHumidity ?? null,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                    );
                    stmt.finalize();
                }
            } 
        } catch (err) {
            // 忽略無法解碼的雜訊封包
        }
    });
}