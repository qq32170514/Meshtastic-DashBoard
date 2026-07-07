const mqtt = require('mqtt');
const protobuf = require('protobufjs');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const cron = require('node-cron');
const os = require('os');
const net = require('net'); // 🚀 引入 Node.js 原生 TCP 模組
require('dotenv').config(); // 讀取 .env 檔案

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 讓 Express 信任 Cloudflare 轉發的標頭 (這對於取得真實訪客 IP 很重要)
app.set('trust proxy', true);

const seenPackets = new Set(); // 🛑 用於攔截 MQTT 重複封包的快取

let isMqttConnected = false; // 紀錄 MQTT 連線狀態

// ==========================================
// 🚀 WebSocket 批量推播緩衝（減少高峰期 re-render）
// ==========================================
const pendingBatch = { raw_packet: [], node_seen: [], telemetry_update: [] };
let batchEmitTimer = null;

function flushPendingBatch() {
    if (pendingBatch.raw_packet.length) {
        io.emit('raw_packet_batch', pendingBatch.raw_packet.splice(0));
    }
    if (pendingBatch.node_seen.length) {
        io.emit('node_seen_batch', pendingBatch.node_seen.splice(0));
    }
    if (pendingBatch.telemetry_update.length) {
        io.emit('telemetry_batch', pendingBatch.telemetry_update.splice(0));
    }
    batchEmitTimer = null;
}

/**
 * 🚀 批次推播：100ms 內的事件會合併成一個陣列發送
 * 大幅減少前端 React re-render 次數
 */
function batchEmit(type, data) {
    pendingBatch[type].push(data);
    if (!batchEmitTimer) {
        batchEmitTimer = setTimeout(flushPendingBatch, 1000); // 🚀 優化: 將推播緩衝提高到 1000ms，大幅減輕前端負擔
    }
}

// ==========================================
// 🚀 In-Memory API 快取層 (10秒 TTL)
// 大幅減少重複查詢對 SQLite 的壓力
// ==========================================
const CACHE_TTL_MS = 10 * 1000; // 10 秒
const apiCache = new Map();

/**
 * Express 中間件：自動快取 GET 回應
 * 快取命中時直接回傳，不碰 DB
 */
function withCache(ttlMs = CACHE_TTL_MS) {
    return (req, res, next) => {
        const key = req.originalUrl;
        const cached = apiCache.get(key);
        if (cached && Date.now() < cached.expiredAt) {
            res.setHeader('X-Cache', 'HIT');
            return res.json(cached.data);
        }
        // 攔截 res.json 以存入快取
        const origJson = res.json.bind(res);
        res.json = (data) => {
            apiCache.set(key, { data, expiredAt: Date.now() + ttlMs });
            res.setHeader('X-Cache', 'MISS');
            origJson(data);
        };
        next();
    };
}

/**
 * 當有新封包寫入資料庫時，清除所有 packet 相關的快取
 * 避免前端看到過時的分頁資料
 */
function invalidatePacketCache() {
    for (const key of apiCache.keys()) {
        if (key.startsWith('/api/packets') || key.startsWith('/api/node/') || key.startsWith('/api/coverage')) {
            apiCache.delete(key);
        }
    }
}

// ==========================================
// 🚀 資料庫批次寫入任務佇列 (DB Queue)
// 解決高流量時頻繁觸發 SQLite 鎖的問題
// ==========================================
const dbQueue = [];
let dbQueueTimer = null;

function queueDbOp(sql, params, callback) {
    dbQueue.push({ sql, params, callback });
    if (!dbQueueTimer) {
        dbQueueTimer = setTimeout(() => {
            if (dbQueue.length === 0) return;
            const batch = dbQueue.splice(0);
            dbQueueTimer = null;

            db.serialize(() => {
                db.run('BEGIN');
                batch.forEach(item => {
                    db.run(item.sql, item.params, item.callback);
                });
                db.run('COMMIT');
            });
            // 🚀 批次寫入完成後，讓快取失效
            invalidatePacketCache();
        }, 1000); // 每秒批次寫入一次資料庫
    }
}

// ==========================================
// Socket.io 連線監聽 (新增)
// ==========================================
io.on('connection', (socket) => {
    // 取得真實訪客 IP (相容 Cloudflare)
    const clientIp = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address;
    console.log(`🔌 有新用戶連線 [IP: ${clientIp}] 到 Dashboard:`, socket.id);
    // 當用戶剛連線時，立即告知當前的 MQTT 狀態
    socket.emit('mqtt_status', { connected: isMqttConnected });
    socket.on('disconnect', () => console.log('❌ 用戶已中斷連線'));
});

// 🛡️ 解密引擎預處理
const safeBase64 = (str) => str.replace(/-/g, '+').replace(/_/g, '/');
const knownKeys = [
    { name: "MediumFast", key: Buffer.from("1PG7OiApB1nwvP+rz05pAQ==", "base64") },
    { name: "MeshTW", key: Buffer.from(safeBase64("isDhHrNpJPlGX3GBJBX6kjuK7KQNp4Z0M7OTDpnX5N4"), "base64") },
    { name: "SignalTest", key: Buffer.from(safeBase64("y1HciVgpl5Hzh05KJUe/umWUH8XhG3UjR1rvZHfUHFU="), "base64") },
    { name: "Emergency!", key: Buffer.from(safeBase64("isDhHrNpJPlGX3GBJBX6kjuK7KQNp4Z0M7OTDpnX5N4"), "base64") }
];

// 捕捉全域未處理錯誤，防止程式無預警結束
process.on('uncaughtException', (err) => {
    console.error('💥 偵測到未捕獲的異常 (Uncaught Exception):', err);
});

// 你的專屬節點 ID
const myNodeId = '!7931b961';

// 靜態檔案路徑：優先服務前端編譯出的 dist 夾，若無則服務目前目錄（相容舊 index.html）
app.use(express.static(path.join(__dirname, 'frontend/dist'))); // 🚀 安全性：只服務前端編譯後的檔案

// ==========================================
// 1. 初始化 SQLite 資料庫
// ==========================================
// ⚡ 雲端轉型：如果偵測到 TURSO_URL，則連線至雲端資料庫，否則使用本地 SQLite
let db;
if (process.env.TURSO_URL) {
    const client = createClient({
        url: process.env.TURSO_URL,
        authToken: process.env.TURSO_TOKEN,
    });
    // 建立一個相容 sqlite3 語法的包裝器
    db = {
        run: (sql, params, cb) => client.execute({ sql, args: params || [] }).then(r => cb && cb.call({ lastID: Number(r.lastInsertRowid) }, null)).catch(cb),
        all: (sql, params, cb) => client.execute({ sql, args: params || [] }).then(r => cb(null, r.rows)).catch(cb),
        get: (sql, params, cb) => client.execute({ sql, args: params || [] }).then(r => cb(null, r.rows[0])).catch(cb),
        serialize: (fn) => fn()
    };
    console.log(`☁️ 已連線至 Turso 雲端資料庫`);
} else {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, 'meshtastic.db');
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) console.error('❌ 本地資料庫連線失敗:', err.message);
        else console.log(`🗄️ 本地資料庫連線成功: ${dbPath}`);
    });
}

db.serialize(() => {
    // 🚀 效能優先：所有 DDL 前先設定最佳 PRAGMA
    db.run(`PRAGMA journal_mode = WAL`);
    db.run(`PRAGMA synchronous = NORMAL`);   // WAL 模式下 NORMAL 夠安全，比 FULL 快約 5x
    db.run(`PRAGMA cache_size = -32000`);    // 32MB 頁面快取（負值代表 KB）
    db.run(`PRAGMA temp_store = MEMORY`);    // 暫存運算全放記憶體
    db.run(`PRAGMA mmap_size = 268435456`);  // 256MB mmap 加速讀取
    db.run(`PRAGMA busy_timeout = 5000`);    // 5秒等待鎖，避免 SQLITE_BUSY 錯誤

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
            hop_start INTEGER,
            adc_voltage REAL
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
            hw_model TEXT,
            battery_level REAL,
            voltage REAL,
            current REAL,
            temperature REAL,
            humidity REAL,
            firmware_version TEXT,
            firmware_build_num TEXT,
            last_gateway TEXT
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
    // 新增 neighbors 資料表，紀錄節點間的鄰居關係 (拓撲核心)
    db.run(`
        CREATE TABLE IF NOT EXISTS neighbors (
            node_id TEXT,
            neighbor_id TEXT,
            snr REAL,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(node_id, neighbor_id)
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
    // 🚀 核心升級：實體 RF 攔截專用表 (支援多來源標記)
    db.run(`
        CREATE TABLE IF NOT EXISTS packets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT,
            lat REAL,
            lon REAL,
            snr REAL,
            rssi REAL,
            source TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_packets_timestamp ON packets(timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_gateway ON packet_logs(gateway_id)`);

    const cols = [
        { t: 'nodes', c: 'is_favorite', d: 'INTEGER DEFAULT 0' },
        { t: 'nodes', c: 'last_topic', d: 'TEXT' },
        { t: 'packet_logs', c: 'gateway_id', d: 'TEXT' },
        { t: 'telemetry_data', c: 'current', d: 'REAL' },
        { t: 'packet_logs', c: 'hop_limit', d: 'INTEGER' },
        { t: 'packet_logs', c: 'hop_start', d: 'INTEGER' },
        { t: 'packet_logs', c: 'payload_json', d: 'TEXT' },
        { t: 'packet_logs', c: 'raw_hex', d: 'TEXT' },
        { t: 'nodes', c: 'hop_limit', d: 'INTEGER' },
        { t: 'nodes', c: 'hop_start', d: 'INTEGER' },
        { t: 'nodes', c: 'role', d: 'TEXT' },
        { t: 'nodes', c: 'channel', d: 'TEXT' },
        { t: 'nodes', c: 'hw_model', d: 'TEXT' },
        { t: 'nodes', c: 'battery_level', d: 'REAL' },
        { t: 'nodes', c: 'voltage', d: 'REAL' },
        { t: 'nodes', c: 'current', d: 'REAL' },
        { t: 'nodes', c: 'temperature', d: 'REAL' },
        { t: 'nodes', c: 'humidity', d: 'REAL' },
        { t: 'nodes', c: 'firmware_version', d: 'TEXT' },
        { t: 'nodes', c: 'firmware_build_num', d: 'TEXT' },
        { t: 'nodes', c: 'last_gateway', d: 'TEXT' },
        { t: 'packet_logs', c: 'latitude', d: 'REAL' },
        { t: 'packet_logs', c: 'longitude', d: 'REAL' },
        { t: 'packet_logs', c: 'hops_away', d: 'INTEGER' },
        { t: 'packet_logs', c: 'source', d: 'TEXT' }, // 🚀 新增：標記封包來源 (MQTT 或 RF 隧道)
        { t: 'telemetry_data', c: 'adc_voltage', d: 'REAL' } // 🚀 新增：保留 ADC 電壓
    ];
    cols.forEach(col => {
        db.run(`ALTER TABLE ${col.t} ADD COLUMN ${col.c} ${col.d}`, (err) => { });
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_data (timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_node_timestamp ON telemetry_data (node_id, timestamp DESC)`);
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_node_id ON packet_logs (node_id)`);
    // 🚀 效能優化：為 packet_logs 的 timestamp 加上索引，加速 ORDER BY timestamp DESC 的查詢
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_timestamp ON packet_logs (timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_source_timestamp ON packet_logs (source, timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_node_timestamp ON packet_logs (node_id, timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_portnum_timestamp ON packet_logs (portnum, timestamp DESC)`);
    
    // 聊天紀錄效能優化
    db.run(`CREATE INDEX IF NOT EXISTS idx_chat_channel_timestamp ON chat_messages (channel_name, timestamp DESC)`);
});

// 🛸 輔助映射：將前端名稱對應回 Protobuf ID，確保 API 查詢正確
const PORT_NAME_TO_ID = {
    'TEXT_MESSAGE': 1,
    'POSITION': 3,
    'NODEINFO': 4,
    'ROUTING': 5,
    'ADMIN': 6,
    'STAT_LOG': 64,
    'WAYPOINT': 65,
    'TELEMETRY': 67,
    'TRACEROUTE': 70,
    'NEIGHBORINFO': 71,
    'MAP_REPORT': 73,
    'ENCRYPTED': 'ENCRYPTED'
};

// ==========================================
// 1.2 資料清理任務 (保留 3 天)
// ==========================================
const DATA_RETENTION_DAYS = 30; // 🚀 在這裡設定你想要保留數據的天數 (例如 30 天)

function cleanupOldData() {
    const sql = `DELETE FROM telemetry_data WHERE timestamp < datetime('now', '-${DATA_RETENTION_DAYS} days')`;
    const sqlPackets = `DELETE FROM packet_logs WHERE timestamp < datetime('now', '-${DATA_RETENTION_DAYS} days')`;
    // 新增：聊天紀錄保留 30 天，避免資料庫無限增長
    const sqlChat = `DELETE FROM chat_messages WHERE timestamp < datetime('now', '-${DATA_RETENTION_DAYS} days')`;

    db.run(sql, function (err) {
        if (err) console.error('❌ 清理舊資料失敗:', err.message);
        else if (this.changes > 0) {
            console.log(`🧹 自動清理完成，已刪除 ${this.changes} 筆超過 14 天的舊資料`);
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

// 🛸 輔助函式：構建封包查詢條件
const buildPacketQuery = (req, baseSql) => {
    let sql = baseSql;
    const params = [];
    const conditions = [];

    if (req.params.nodeId) {
        conditions.push("node_id = ?");
        params.push(req.params.nodeId);
    }
    if (req.query.node_ids) {
        const ids = req.query.node_ids.split(',');
        conditions.push(`node_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }
    if (req.query.portnum) {
        const pid = PORT_NAME_TO_ID[req.query.portnum];
        if (pid) {
            // 同時查詢名稱與數字 ID，確保相容性
            conditions.push("(portnum = ? OR portnum = ?)");
            params.push(req.query.portnum, pid.toString());
        } else {
            conditions.push("portnum = ?");
            params.push(req.query.portnum);
        }
    }
    if (req.query.gateway_id) {
        conditions.push("gateway_id LIKE ?");
        params.push(`%${req.query.gateway_id}%`);
    }
    if (req.query.timeStart) {
        conditions.push("timestamp >= ?");
        params.push(req.query.timeStart);
    }
    if (req.query.timeEnd) {
        conditions.push("timestamp <= ?");
        params.push(req.query.timeEnd);
    }
    if (req.query.minSnr) {
        conditions.push("snr >= ?");
        params.push(parseFloat(req.query.minSnr));
    }
    // 🚀 新增：排除隧道封包的條件 (僅用於全域封包觀察)
    if (req.excludeTunnelPackets) {
        conditions.push("(source IS NULL OR source = 'mqtt')");
    }

    if (req.query.minRssi) {
        conditions.push("rssi >= ?");
        params.push(parseFloat(req.query.minRssi));
    }

    if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
    }
    return { sql, params };
};

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
// 🚀 效能優化：只取列表需要的欄位，排除 payload_json 和 raw_hex 這兩個大字段
const PACKET_LIST_COLS = `id, node_id, timestamp, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, hops_away, latitude, longitude, source`;

app.get('/api/packets', withCache(), (req, res) => {
    // 1. 強制設定安全上限，防止有人惡意或無意間請求過大資料量
    const rawLimit = parseInt(req.query.limit) || 50;
    const limit = Math.min(rawLimit, 100);

    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const { sql, params } = buildPacketQuery({ ...req, excludeTunnelPackets: true }, `SELECT ${PACKET_LIST_COLS} FROM packet_logs`);
    const finalSql = `${sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;

    db.all(finalSql, [...params, limit, offset], (err, rows) => {
        if (err) {
            console.error('❌ API /api/packets SQL Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 🚀 新增：單一封包詳情（懶加載），包含 payload_json 和 raw_hex
app.get('/api/packets/:id', (req, res) => {
    db.get(`SELECT * FROM packet_logs WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        // 如果 payload_json 是字串先解析再回傳
        if (row.payload_json && typeof row.payload_json === 'string') {
            try { row.payload_json = JSON.parse(row.payload_json); } catch (_) {}
        }
        res.json(row);
    });
});

// 🚀 全域封包總數統計（加快取）
app.get('/api/packets/count', withCache(), (req, res) => {
    const { sql, params } = buildPacketQuery(req, "SELECT COUNT(*) as count FROM packet_logs");
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: row?.count || 0 });
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

// 取得全域閘道器排行榜
app.get('/api/gateways/leaderboard', (req, res) => {
    const sql = `
        SELECT gateway_id, COUNT(*) as total_packets, AVG(snr) as avg_snr, MAX(timestamp) as last_active 
        FROM packet_logs 
        WHERE gateway_id IS NOT NULL AND gateway_id != '' AND gateway_id != 'Unknown'
        GROUP BY gateway_id 
        HAVING MAX(timestamp) >= datetime('now', '-3 days')
        ORDER BY total_packets DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 取得系統狀態與健康度 (Dashboard Health)
app.get('/api/sys-status', (req, res) => {
    try {
        const dbFile = path.join(__dirname, 'meshtastic.db');
        let dbSize = 0;
        if (fs.existsSync(dbFile)) {
            dbSize = fs.statSync(dbFile).size;
        }
        res.json({
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu_load: os.loadavg(),
            db_size: dbSize,
            node_version: process.version
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 取得節點通訊密度統計 (過去 24 小時發包量)
app.get('/api/nodes/activity', (req, res) => {
    const sql = `
        SELECT node_id, COUNT(*) as count 
        FROM packet_logs 
        WHERE timestamp > datetime('now', '-1 day')
        GROUP BY node_id`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 🚀 新增：取得節點過去 24 小時的移動軌跡 (Tracker History)
app.get('/api/node-path/:id', (req, res) => {
    const nodeId = req.params.id;
    const sql = `
        SELECT latitude, longitude, timestamp 
        FROM packet_logs 
        WHERE node_id = ? 
          AND latitude IS NOT NULL 
          AND longitude IS NOT NULL 
          AND timestamp > datetime('now', '-1 day')
        ORDER BY timestamp ASC`;
    db.all(sql, [nodeId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 🚀 新增：取得頻道的數據分析 (Chat Analytics)
app.get('/api/chat-analytics/:channel', (req, res) => {
    const channel = req.params.channel;
    // 統計前10大發言者
    const talkersSql = `
        SELECT from_id, COUNT(*) as message_count 
        FROM chat_messages 
        WHERE channel_name = ? AND timestamp > datetime('now', '-7 days')
        GROUP BY from_id 
        ORDER BY message_count DESC 
        LIMIT 10`;
    
    // 取得文字內容準備進行文字雲拆解
    const wordsSql = `
        SELECT message 
        FROM chat_messages 
        WHERE channel_name = ? AND timestamp > datetime('now', '-7 days')
        LIMIT 500`;

    db.all(talkersSql, [channel], (err, talkers) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(wordsSql, [channel], (err, messages) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // 簡單的空格拆詞法 (適合英數夾雜或有斷詞的中文)
            const wordCounts = {};
            messages.forEach(row => {
                // 移除非英數字/中文字元，將逗號句號等替換為空白，然後用空白切割
                const cleanMsg = row.message.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
                const tokens = cleanMsg.split(/\s+/);
                tokens.forEach(token => {
                    if (token.length > 1) { // 忽略單一字元
                        wordCounts[token] = (wordCounts[token] || 0) + 1;
                    }
                });
            });

            // 轉換為陣列並排序取前 50 個
            const wordCloud = Object.entries(wordCounts)
                .map(([text, value]) => ({ text, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 50);

            res.json({
                topTalkers: talkers,
                wordCloud: wordCloud
            });
        });
    });
});

// 🚀 新增：太陽能電壓預測 API
// 🚀 新增：取得最新一筆 Traceroute 路徑 API
app.get('/api/traceroute/latest', (req, res) => {
    const sql = `SELECT payload_json FROM packet_logs WHERE portnum = '70' OR portnum = 'TRACEROUTE_APP' ORDER BY timestamp DESC LIMIT 1`;
    db.get(sql, [], (err, row) => {
        if (err || !row) return res.json([]);
        try {
            const payload = JSON.parse(row.payload_json);
            const route = payload.route || [];

            // 將十進位 ID 轉為 !hex 格式 (例如 !f0b78d83)
            const hexIds = route.map(id => `!${(id >>> 0).toString(16).padStart(8, '0')}`);
            const placeholders = hexIds.map(() => '?').join(',');

            db.all(`SELECT node_id, latitude, longitude, short_name FROM nodes WHERE node_id IN (${placeholders})`, hexIds, (err, nodes) => {
                if (err) return res.status(500).json({ error: err.message });
                // 依照原始 route 的順序排序返回，並過濾掉沒有座標的節點
                const sortedPath = hexIds.map(id => nodes.find(n => n.node_id === id)).filter(n => n && n.latitude);
                res.json(sortedPath);
            });
        } catch (e) {
            res.json([]);
        }
    });
});

// 🚀 核心升級：網格化覆蓋率聚合 API
// 🚀 效能優化：用 CTE 取代相關子查詢，消滅 N+1 問題
app.get('/api/coverage/griddata', withCache(30 * 1000), (req, res) => {
    // 🚀 CTE 實作方式：
    // 1. 第一個 CTE 先對每個網格分組找出最新那筆的 hops_away
    // 2. 第二個層做聚合統計
    // 3. JOIN 合併起來，對每行只跟資料庫講一次
    const sql = `
        WITH base AS (
            SELECT 
                CAST(ROUND(latitude  / 0.005) * 0.005 AS REAL) AS grid_lat,
                CAST(ROUND(longitude / 0.005) * 0.005 AS REAL) AS grid_lng,
                snr, hops_away, timestamp, node_id, gateway_id
            FROM packet_logs
            WHERE latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND node_id != gateway_id
              AND gateway_id != 'Unknown'
        ),
        latest_per_grid AS (
            SELECT grid_lat, grid_lng, hops_away
            FROM (
                SELECT grid_lat, grid_lng, hops_away,
                       ROW_NUMBER() OVER (
                           PARTITION BY grid_lat, grid_lng
                           ORDER BY timestamp DESC
                       ) AS rn
                FROM base
            ) t
            WHERE rn = 1
        )
        SELECT 
            b.grid_lat,
            b.grid_lng,
            COUNT(*)        AS packet_count,
            AVG(b.snr)      AS avg_snr,
            MIN(b.hops_away) AS min_hops,
            MAX(b.timestamp) AS latest_time,
            l.hops_away     AS latest_hops
        FROM base b
        JOIN latest_per_grid l USING (grid_lat, grid_lng)
        GROUP BY b.grid_lat, b.grid_lng
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 取得目前網路的所有鄰居關係 (拓撲層使用)
app.get('/api/neighbors', (req, res) => {
    db.all(`SELECT * FROM neighbors WHERE last_seen > datetime('now', '-2 days')`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 提供給前端邏輯拓樸圖層的連線資料
app.get('/api/topology/fusion-edges', (req, res) => {
    const query = `
        SELECT node_id as source_id, neighbor_id as target_id, 80 as confidence, 'NEIGHBOR_INFO' as method, snr
        FROM neighbors WHERE last_seen > datetime('now', '-2 days')
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 取得單一節點的歷史封包紀錄
// 🚀 效能優化：只取列表需要欄位，加快取
app.get('/api/node/:nodeId/packets', withCache(), (req, res) => {
    const { sql, params } = buildPacketQuery(req, `SELECT ${PACKET_LIST_COLS} FROM packet_logs`);
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const finalSql = `${sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    db.all(finalSql, [...params, limit, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 🚀 單一節點封包總數統計（加快取）
app.get('/api/node/:nodeId/packets/count', withCache(), (req, res) => {
    const { sql, params } = buildPacketQuery(req, "SELECT COUNT(*) as count FROM packet_logs");
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: row?.count || 0 });
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

// 啟動 Express 伺服器
server.listen(PORT, () => {
    console.log(`🚀 API 伺服器已啟動: http://localhost:${PORT}`);
    console.log(`📊 嘗試存取資料: http://localhost:${PORT}/api/telemetry`);
    // 啟動 RF 監聽
    setupRFListener(io, db);
});


// ==========================================
// 🛰️ 實體 RF 隧道攔截模組 (HiveMQ 雲端分流對接)
// ==========================================
async function setupRFListener(io, db) {
    const relayConfigs = [
        { name: 'hualien', label: '花蓮站', port: 4404 },
        { name: 'taoyuan', label: '台北站', port: 4405 },
        { name: 'sanzhi', label: '三芝站', port: 4406 }
    ];

    let meshtastic;
    try {
        meshtastic = await import('@meshtastic/meshtasticjs');
    } catch (err) {
        console.error('❌ [隧道模組] 無法載入套件:', err.message);
        return;
    }

    const m = meshtastic.default || meshtastic;
    const { FromRadio, Position } = m.Protobuf;

    if (!FromRadio || !Position) {
        console.error('❌ [隧道模組] 無法找到 Protobuf 解碼字典');
        return;
    }

    relayConfigs.forEach(config => {
        const connectToRelay = () => {
            try {
                console.log(`📡 [原生 TCP] 正在連線至 ${config.label} (127.0.0.1:${config.port})...`);
                const socket = new net.Socket();

                socket.connect(config.port, '127.0.0.1', () => {
                    console.log(`✅ [原生 TCP] ${config.label} 已連線！`);
                });

                socket.on('data', (buffer) => {
                    try {
                        const fromRadio = FromRadio.fromBinary(buffer);
                        if (fromRadio.packet && fromRadio.packet.decoded) {
                            const packet = fromRadio.packet;
                            const decoded = packet.decoded;
                            if (decoded.portnum === 3 || decoded.portnum === 'POSITION_APP') {
                                const pos = Position.fromBinary(decoded.payload);
                                const lat = (pos.latitudeI !== undefined) ? pos.latitudeI / 1e7 : null;
                                const lng = (pos.longitudeI !== undefined) ? pos.longitudeI / 1e7 : null;
                                if (!lat || !lng) return;

                                const fromId = `!${packet.from.toString(16).padStart(8, '0')}`;
                                const hopsAway = (packet.hopStart || 0) - (packet.hopLimit || 0);

                                console.log(`📍 [隧道位置] 來源: ${config.label} | 節點: ${fromId} -> ${lat.toFixed(6)}, ${lng.toFixed(6)} (Hops: ${hopsAway})`);

                                const packetData = {
                                    from: fromId,
                                    portnum: 'POSITION',
                                    topic: `tunnel/${config.name}/rx`,
                                    gateway_id: `RELAY_${config.name.toUpperCase()}`,
                                    timestamp: new Date().toISOString(),
                                    time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
                                    snr: packet.rxSnr ?? null,
                                    rssi: packet.rxRssi ?? null,
                                    latitude: lat,
                                    longitude: lng,
                                    source: config.name,
                                    sourceLabel: config.label,
                                    hops_away: hopsAway
                                };

                                db.serialize(() => {
                                    db.run('BEGIN');
                                    db.run(`INSERT INTO packet_logs (node_id, portnum, gateway_id, snr, rssi, latitude, longitude, hops_away, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [fromId, 'POSITION', packetData.gateway_id, packet.rxSnr, packet.rxRssi, lat, lng, hopsAway, config.name]);
                                    db.run(`UPDATE nodes SET last_seen = CURRENT_TIMESTAMP, last_gateway = ? WHERE node_id = ?`,
                                        [`隧道:${config.label}`, fromId]);
                                    db.run('COMMIT');
                                });
                                batchEmit('raw_packet', packetData);
                            }
                        }
                    } catch (e) { /* 忽略碎片或錯誤封包 */ }
                });

                socket.on('close', () => {
                    console.warn(`⚠️ [TCP 斷開] ${config.label}，10秒後重連...`);
                    setTimeout(connectToRelay, 10000);
                });

                socket.on('error', (err) => {
                    console.error(`❌ [TCP 錯誤] ${config.label}:`, err.message);
                });

            } catch (err) {
                console.error(`❌ [隧道異常] ${config.label}:`, err.message);
                setTimeout(connectToRelay, 15000);
            }
        };

        connectToRelay();
    });
}
// ==========================================
// 2. 設定 Protobuf 解析器
// ==========================================
const root = new protobuf.Root();
root.resolvePath = (origin, target) => __dirname + '/protobufs/' + target;

// 檢查基礎檔案是否存在
const checkPath = path.join(__dirname, 'protobufs', 'meshtastic', 'mqtt.proto');
if (!fs.existsSync(checkPath)) {
    console.error(`\n⚠️  錯誤：找不到 Protobuf 定義檔！`);
    console.error(`請確保檔案位於: ${checkPath}`);
    console.error(`你可以從 https://github.com/meshtastic/protobufs 下載檔案並放入該目錄。\n`);
}

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
    const client = mqtt.connect(process.env.MQTT_BROKER || 'mqtt://mqtt.meshtastic.org', {
        username: process.env.MQTT_USER || 'meshdev',
        password: process.env.MQTT_PASSWORD || 'large4cats',
        clientId: 'mesh_dash_' + Math.random().toString(16).substring(2, 10),
        connectTimeout: 5000
    });

    client.on('connect', () => {
        console.log('✅ 已成功連線到 MQTT 伺服器！');
        isMqttConnected = true;
        io.emit('mqtt_status', { connected: true }); // mqtt_status 需要立即發送，不能批次

        // 只訂閱台灣區域的 Topic (# 代表監聽 TW 路徑下的所有子頻道)
        const topics = (process.env.MQTT_TOPICS || 'msh/TW/#').split(',');
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
                INSERT INTO nodes (node_id, last_seen, last_topic, channel, hop_limit, hop_start, last_gateway) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET last_seen=excluded.last_seen, last_topic=excluded.last_topic, channel=COALESCE(excluded.channel, nodes.channel), hop_limit=excluded.hop_limit, hop_start=excluded.hop_start, last_gateway=excluded.last_gateway
            `;
            // 🚀 批次寫入：改用佇列避免高流量時的鎖等待
            queueDbOp(nodeUpdateSql, [fromId, topic, resolvedChannel, packet.hop_limit || 0, packet.hop_start || 0, gatewayId]);
            batchEmit('node_seen', { node_id: fromId, last_seen: new Date().toISOString(), last_topic: topic, channel: resolvedChannel });

            // 2. 如果最終仍無法解碼，則標記為 ENCRYPTED
            if (!decodedData) {
                const hopsAway = Math.max(0, (packet.hop_start || 0) - (packet.hop_limit || 0));
                queueDbOp(`INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex, hops_away) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [fromId, 'ENCRYPTED', topic, gatewayId, packet.rx_snr || null, packet.rx_rssi || null, packet.hop_limit || 0, packet.hop_start || 0, null, rawHex, hopsAway]);
                batchEmit('raw_packet', {
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
            // 🛡️ 初始化為 null，確保 SQL 寫入正確
            let packetLat = undefined;
            let packetLng = undefined;

            const payloadBuffer = Buffer.isBuffer(decodedData.payload) ? decodedData.payload : Buffer.from(decodedData.payload || []);

            try {
                if (port === 1 || port === 'TEXT_MESSAGE_APP') {
                    const textMessage = payloadBuffer.toString('utf8');
                    const channelName = decodedData.channel_name || 'MediumFast';
                    payloadObj = { text: textMessage, channel_name: channelName };

                    console.log(`💬 [頻道: ${channelName}] ${fromId} 說: ${textMessage}`);

                    // 寫入聊天紀錄表
                    queueDbOp(`INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)`, [fromId, textMessage, channelName]);
                } else if (port === 3 || port === 'POSITION_APP' || port === '3') {
                    // 確保我們正確解碼 Meshtastic 標準位置
                    const posMessage = Position.decode(payloadBuffer);
                    payloadObj = Position.toObject(posMessage, { enums: String, defaults: true });

                    // 🛸 強化座標讀取，避免數值為 0 被誤判
                    packetLat = (payloadObj.latitude_i !== undefined) ? payloadObj.latitude_i / 1e7 : payloadObj.latitude;
                    packetLng = (payloadObj.longitude_i !== undefined) ? payloadObj.longitude_i / 1e7 : payloadObj.longitude;
                } else if (port === 4 || port === 'NODEINFO_APP') {
                    payloadObj = User.toObject(User.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 5 || port === 'ROUTING_APP') {
                    payloadObj = Routing.toObject(Routing.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 67 || port === 'TELEMETRY_APP') {
                    payloadObj = Telemetry.toObject(Telemetry.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 70 || port === 'TRACEROUTE_APP') {
                    payloadObj = RouteDiscovery.toObject(RouteDiscovery.decode(payloadBuffer), { enums: String, defaults: true });
                } else if (port === 71 || port === 'NEIGHBORINFO_APP') {
                    const ni = NeighborInfo.decode(payloadBuffer);
                    payloadObj = NeighborInfo.toObject(ni, { enums: String, defaults: true });
                    // 寫入拓撲關係
                    if (ni.neighbors && ni.neighbors.length > 0) {
                        ni.neighbors.forEach(n => {
                            const nId = `!${n.node_id.toString(16).padStart(8, '0')}`;
                            queueDbOp(`INSERT INTO neighbors (node_id, neighbor_id, snr) VALUES (?, ?, ?) ON CONFLICT(node_id, neighbor_id) DO UPDATE SET snr=excluded.snr, last_seen=CURRENT_TIMESTAMP`, [fromId, nId, n.snr]);
                        });
                    }
                } else if (port === 73 || port === 'MAP_REPORT_APP') {
                    const report = MapReport.decode(payloadBuffer);
                    payloadObj = MapReport.toObject(report, { enums: String, defaults: true });
                    packetLat = report.latitude_i ? report.latitude_i / 1e7 : report.latitude;
                    packetLng = report.longitude_i ? report.longitude_i / 1e7 : report.longitude;
                }
            } catch (e) { console.error('❌ Payload 解析失敗', e); }

            if (payloadObj && decodedData.channel_name) {
                payloadObj.channel_name = decodedData.channel_name;
            }

            // 3. 寫入封包日誌並推播
            const payloadJson = payloadObj ? JSON.stringify(payloadObj) : null;
            const hopsAway = Math.max(0, (packet.hop_start || 0) - (packet.hop_limit || 0));

            // 🚀 同步更新 nodes 表中的座標，讓地圖 Marker 能即時移動
            if (packetLat && packetLng) {
                queueDbOp(`UPDATE nodes SET latitude = ?, longitude = ? WHERE node_id = ?`, [packetLat, packetLng, fromId]);
            }

            queueDbOp(`INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex, latitude, longitude, hops_away) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [fromId, port, topic, gatewayId, packet.rx_snr || null, packet.rx_rssi || null, packet.hop_limit || 0, packet.hop_start || 0, payloadJson, rawHex, packetLat, packetLng, hopsAway]);

            batchEmit('raw_packet', {
                from: fromId,
                portnum: port,
                topic: topic,
                gateway_id: gatewayId,
                timestamp: new Date().toISOString(),
                time: new Date().toLocaleTimeString(),
                snr: packet.rx_snr,
                rssi: packet.rx_rssi,
                latitude: packetLat,
                longitude: packetLng,
                hops_away: hopsAway,
                payload_json: payloadObj,
                rawData: rawHex
            });

            // 解析節點資訊 (名稱) - NODEINFO 外層更新
            if (port === 4 || port === 'NODEINFO_APP') {
                try {
                    const user = User.toObject(User.decode(payloadBuffer), { enums: String });
                    const finalRole = user.role || 'CLIENT';
                    const hwModel = user.hw_model || user.hwModel || null;
                    const firmwareVersion = user.firmware_version || user.firmwareVersion || null;
                    const firmwareBuildNum = user.firmware_build_num || user.firmwareBuildNum || null;
                    queueDbOp(`UPDATE nodes SET long_name = ?, short_name = ?, role = ?, hw_model = ?, firmware_version = ?, firmware_build_num = ? WHERE node_id = ?`,
                        [user.long_name, user.short_name, finalRole, hwModel, firmwareVersion, firmwareBuildNum, fromId], function (err) {
                            if (!err) {
                                console.log(`👤 [節點資訊] 更新: ${user.short_name} 角色: ${finalRole}`);
                                batchEmit('node_seen', {
                                    node_id: fromId,
                                    long_name: user.long_name,
                                    short_name: user.short_name,
                                    role: finalRole,
                                    hw_model: hwModel,
                                    firmware_version: firmwareVersion,
                                    firmware_build_num: firmwareBuildNum,
                                    last_seen: new Date().toISOString(),
                                    last_topic: topic
                                });
                            }
                        });
                } catch (e) { console.error('❌ 解析 NodeInfo 失敗', e); }
            }

            // 解析位置資訊 - POSITION 外層更新
            if (port === 3 || port === 'POSITION_APP') {
                try {
                    const pos = Position.decode(decodedData.payload);
                    if (pos.latitude_i && pos.longitude_i) {
                        const lat = pos.latitude_i / 1e7;
                        const lng = pos.longitude_i / 1e7;
                        queueDbOp(`UPDATE nodes SET latitude = ?, longitude = ? WHERE node_id = ?`, [lat, lng, fromId], function (err) {
                            if (!err) {
                                batchEmit('node_seen', {
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

            if (port === 73 || port === 'MAP_REPORT_APP') {
                try {
                    const report = MapReport.decode(decodedData.payload);
                    const lat = report.latitude_i / 1e7;
                    const lng = report.longitude_i / 1e7;
                    queueDbOp(`
                        UPDATE nodes SET long_name = ?, short_name = ?, latitude = ?, longitude = ? WHERE node_id = ?
                    `, [report.long_name, report.short_name, lat, lng, fromId], function (err) {
                        if (!err) {
                            console.log(`🗺️ [地圖報告] 節點: ${report.short_name} -> ${lat}, ${lng}`);
                            batchEmit('node_seen', {
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

                // 修改：只顯示 I2C 設備讀到的電壓 (Power Metrics)，忽略板載 ADC 設備電壓 (device.voltage)
                const finalVoltage = power.ch1_voltage ?? power.ch1Voltage ?? null;
                const finalCurrent = power.ch1_current ?? power.ch1Current ?? null;

                const adcVoltage = device.voltage ?? null;

                const sql = `
                    INSERT INTO telemetry_data 
                    (node_id, battery_level, voltage, temperature, humidity, channel_utilization, air_util_tx, snr, rssi, current, hop_limit, hop_start, adc_voltage) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    packet.hop_start || 0,
                    adcVoltage
                ];

                // 同步更新 nodes 表，確保 Dashboard 數據能正確載入 (使用 COALESCE 避免不同 telemetry 互相覆寫)
                queueDbOp(`
                        UPDATE nodes SET 
                            battery_level = COALESCE(?, nodes.battery_level), 
                            voltage = COALESCE(?, nodes.voltage), 
                            current = COALESCE(?, nodes.current), 
                            temperature = COALESCE(?, nodes.temperature), 
                            humidity = COALESCE(?, nodes.humidity) 
                        WHERE node_id = ?
                    `, [params[1], finalVoltage, finalCurrent, params[3], params[4], fromId]);

                queueDbOp(sql, params, function (err) {
                    if (err) return console.error('❌ 寫入資料庫失敗:', err.message);

                    console.log(`💾 [寫入DB成功] 節點: ${fromId} | 紀錄 ID: ${this.lastID}`);
                    // 🚀 透過批次推播即時將新資料推播到前端
                    batchEmit('telemetry_update', {
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
                        hop_limit: params[10],
                        hop_start: params[11],
                        adc_voltage: adcVoltage
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

    // 雲端環境適應：從環境變數讀取備份路徑，若無則不執行備份
    const googleDrivePath = process.env.BACKUP_PATH;

    if (!googleDrivePath) return;

    // 如果資料夾不存在，就自動建立
    if (!fs.existsSync(googleDrivePath)) {
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