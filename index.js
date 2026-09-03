const mqtt = require('mqtt');
const protobuf = require('protobufjs');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const cron = require('node-cron');
const os = require('os');
const net = require('net'); // 🚀 引入 Node.js 原生 TCP 模組
require('dotenv').config(); // 讀取 .env 檔案

// 🛡️ 必要環境變數驗證 (Fail Fast - 缺漏直接終止啟動)
const requiredEnv = ['MQTT_BROKER', 'MQTT_USER', 'MQTT_PASSWORD'];
const missingEnv = requiredEnv.filter(name => !process.env[name]);
if (missingEnv.length > 0) {
    console.error(`❌ [FATAL] 缺少必要的環境變數: ${missingEnv.join(', ')}。系統終止啟動。`);
    throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

// ==========================================
// 📝 系統事件記錄簿 (Local Event Log Book)
// ==========================================
const EVENT_LOG_PATH = path.join(__dirname, 'system_events.json');

function logSystemEvent(eventType, details = {}) {
    const event = {
        timestamp: new Date().toISOString(),
        event: eventType,
        ...details
    };

    let events = [];
    try {
        if (fs.existsSync(EVENT_LOG_PATH)) {
            const fileData = fs.readFileSync(EVENT_LOG_PATH, 'utf8');
            events = JSON.parse(fileData);
        }
    } catch (err) {
        console.error('Failed to read system events file:', err);
    }

    events.push(event);

    try {
        fs.writeFileSync(EVENT_LOG_PATH, JSON.stringify(events, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to write system event:', err);
    }
}

// 啟動檢測邏輯
try {
    const pkg = require('./package.json');
    const currentVersion = pkg.version || 'unknown';
    let lastVersion = null;

    if (fs.existsSync(EVENT_LOG_PATH)) {
        const fileData = fs.readFileSync(EVENT_LOG_PATH, 'utf8');
        const events = JSON.parse(fileData);
        const startupEvents = events.filter(e => e.event === 'SYSTEM_STARTUP');
        if (startupEvents.length > 0) {
            lastVersion = startupEvents[startupEvents.length - 1].version;
        }
    }

    if (lastVersion && lastVersion !== currentVersion) {
        logSystemEvent('PROJECT_UPDATE', {
            old_version: lastVersion,
            new_version: currentVersion,
            description: `專案更新：版本從 v${lastVersion} 變更為 v${currentVersion}`
        });
    }

    logSystemEvent('SYSTEM_STARTUP', {
        version: currentVersion,
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        os_uptime: Math.floor(os.uptime())
    });
} catch (err) {
    console.error('Failed to initialize event log book:', err);
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 🛡️ CORS 與 Origin 白名單處理 (預設優先同源存取)
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];

const io = new Server(server, {
    cors: {
        origin: allowedOrigins.length > 0 ? allowedOrigins : (origin, callback) => callback(null, true),
        methods: ['GET', 'POST']
    }
});

// 🛡️ HTTP 安全標頭防護 (Helmet)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://*.openstreetmap.org"],
            connectSrc: ["'self'", "ws:", "wss:", "https://*.tile.openstreetmap.org"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: null
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(compression());

// 🛡️ 嚴格限制 CORS (若未指定 ALLOWED_ORIGINS 則允許同源)
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS policy'));
    },
    methods: ['GET', 'HEAD']
}));

// 🛡️ 限制 JSON Request Body 大小，防止大封包 DoS
app.use(express.json({ limit: '256kb' }));

// 🛡️ 受約束的代理信任 (僅信任第一層反向代理如 Cloudflare)
app.set('trust proxy', 1);

// 🛡️ Rate Limiting (公開 API 頻率限制防護)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 分鐘
    max: 500, // 每 IP 最多 500 次請求
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const expensiveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, // 針對昂貴查詢更嚴格限制 (每 IP 最多 100 次)
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many analytics requests, please try again later.' }
});

app.use('/api/', apiLimiter);
app.use('/api/analytics/', expensiveLimiter);
app.use('/api/coverage/', expensiveLimiter);

// 🛡️ 分析查詢 range 參數校驗中介軟體 (避免任意超大跨度查詢)
app.use('/api/analytics', (req, res, next) => {
    if (req.query.range && !['24h', '7d', '30d'].includes(req.query.range)) {
        req.query.range = '7d'; // fallback 到安全預設值
    }
    next();
});

// 🛡️ 生產環境內部錯誤遮蔽中介軟體 (避免 SQL 或堆疊洩漏給訪客)
app.use((req, res, next) => {
    const originalJson = res.json;
    res.json = function (body) {
        if (res.statusCode >= 500 && body && body.error && process.env.NODE_ENV === 'production') {
            console.error(`[API 500 Error on ${req.method} ${req.path}]:`, body.error);
            body = { error: 'Internal server error' };
        }
        return originalJson.call(this, body);
    };
    next();
});

const seenPackets = new Set(); // 🛑 用於攔截 MQTT 重複封包的快取

let isMqttConnected = false; // 紀錄 MQTT 連線狀態
let mqttClient = null; // 🚀 Expose MQTT client globally

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

// PUBLIC TEST KEY — NOT SECRET (Standard Meshtastic default public channel key)
const defaultPublicKeys = [
    { name: "MediumFast", key: Buffer.from("1PG7OiApB1nwvP+rz05pAQ==", "base64") } // PUBLIC TEST KEY — NOT SECRET
];

// 動態載入使用者自訂/社群頻道金鑰 (自環境變數 MESHTASTIC_CHANNEL_KEYS_JSON 解析，絕不寫死於原始碼)
function loadCustomChannelKeys() {
    if (!process.env.MESHTASTIC_CHANNEL_KEYS_JSON) {
        return [];
    }
    try {
        const parsed = JSON.parse(process.env.MESHTASTIC_CHANNEL_KEYS_JSON);
        if (Array.isArray(parsed)) {
            return parsed
                .filter(item => item && item.name && item.key)
                .map(item => ({
                    name: String(item.name),
                    key: Buffer.from(safeBase64(String(item.key)), 'base64')
                }));
        }
    } catch (err) {
        console.error('❌ Failed to parse MESHTASTIC_CHANNEL_KEYS_JSON from environment:', err.message);
    }
    return [];
}

const knownKeys = [
    ...defaultPublicKeys,
    ...loadCustomChannelKeys()
];

// 🛡️ 捕捉全域未處理的 Promise 拒絕
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [PROCESS] 未處理的 Promise 拒絕 (Unhandled Rejection):', reason?.message || reason);
});

// 🛡️ 捕捉全域未處理異常 (Fatal Uncaught Exception)，安全記錄並觸發重啟
process.on('uncaughtException', (err) => {
    console.error('💥 [FATAL] 偵測到不可恢復的未捕獲異常 (Uncaught Exception):', err?.message || err);
    try {
        logSystemEvent('SYSTEM_FATAL_ERROR', { error: err?.message || 'Unknown fatal error' });
    } catch (_) { }
    // 留緩衝時間讓 PM2 或 systemd 接手重新啟動乾淨的程序
    setTimeout(() => {
        process.exit(1);
    }, 1000);
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
    db.run(`PRAGMA busy_timeout = 30000`);   // 30秒等待鎖，避免高併發寫入時出現 SQLITE_BUSY 錯誤

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
            source TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS daily_analytics_summary (
            date TEXT PRIMARY KEY,
            active_count INTEGER DEFAULT 0,
            ghost_count INTEGER DEFAULT 0,
            snr_sum REAL DEFAULT 0,
            snr_count INTEGER DEFAULT 0,
            rssi_sum REAL DEFAULT 0,
            rssi_count INTEGER DEFAULT 0,
            temp_sum REAL DEFAULT 0,
            temp_count INTEGER DEFAULT 0,
            hum_sum REAL DEFAULT 0,
            hum_count INTEGER DEFAULT 0,
            position_count INTEGER DEFAULT 0,
            telemetry_count INTEGER DEFAULT 0,
            text_count INTEGER DEFAULT 0,
            routing_count INTEGER DEFAULT 0,
            other_count INTEGER DEFAULT 0,
            hop0_count INTEGER DEFAULT 0,
            hop1_count INTEGER DEFAULT 0,
            hop2_count INTEGER DEFAULT 0,
            hop3_count INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_packets_timestamp ON packets(timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_gateway ON packet_logs(gateway_id)`);

    db.run(`
        CREATE TABLE IF NOT EXISTS cwa_weather_stations (
            station_id TEXT PRIMARY KEY,
            station_name TEXT,
            county TEXT,
            town TEXT,
            latitude REAL,
            longitude REAL,
            temperature REAL,
            humidity REAL,
            weather TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_cwa_lat_lng ON cwa_weather_stations(latitude, longitude)`);

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

    // 🚀 複合索引：大幅提升 NOC 戰情中心 Top Gateways 與重複率查詢速度 (從 5000ms 降至 100ms)
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_gw_ts ON packet_logs (gateway_id, timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_rawhex_ts ON packet_logs (raw_hex, timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_packet_logs_ts_hops ON packet_logs (timestamp DESC, hops_away)`);

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
// 1.2 資料清理任務 (保留 90 天 / 3 個月)
// ==========================================
const DATA_RETENTION_DAYS = 90; // 🚀 保留 90 天 (3 個月)

function cleanupOldData() {
    const sql = `DELETE FROM telemetry_data WHERE timestamp < datetime('now', '-${DATA_RETENTION_DAYS} days')`;
    const sqlPackets = `DELETE FROM packet_logs WHERE timestamp < datetime('now', '-${DATA_RETENTION_DAYS} days')`;
    // 聊天紀錄保留 90 天
    const sqlChat = `DELETE FROM chat_messages WHERE timestamp < datetime('now', '-${DATA_RETENTION_DAYS} days')`;

    db.run(sql, function (err) {
        if (err) console.error('❌ 清理舊資料失敗:', err.message);
        else if (this.changes > 0) {
            console.log(`🧹 自動清理完成，已刪除 ${this.changes} 筆超過 90 天的舊資料`);
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
const buildPacketQuery = (req, baseSql, opts = {}) => {
    let sql = baseSql;
    const params = [];
    const conditions = [];
    const excludeTunnelPackets = opts.excludeTunnelPackets || req.excludeTunnelPackets || false;

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
        conditions.push("(gateway_id LIKE ? OR gateway_id IN (SELECT node_id FROM nodes WHERE long_name LIKE ? OR short_name LIKE ?))");
        const term = `%${req.query.gateway_id}%`;
        params.push(term, term, term);
    }
    if (req.query.sender) {
        conditions.push("(node_id LIKE ? OR node_id IN (SELECT node_id FROM nodes WHERE long_name LIKE ? OR short_name LIKE ?))");
        const term = `%${req.query.sender}%`;
        params.push(term, term, term);
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
    if (excludeTunnelPackets) {
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
    // 🛡️ 強制設定上限，防止惡意請求過大資料量
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rawDays = parseInt(req.query.days, 10);
    const days = (!isNaN(rawDays) && rawDays > 0) ? Math.min(rawDays, 30) : null;

    // 🚀 Payload reduction: Select only fields required by the frontend telemetry chart
    let sql = `SELECT node_id, timestamp, battery_level, voltage, snr, temperature, humidity, channel_utilization, air_util_tx, current, adc_voltage FROM telemetry_data`;
    let conditions = [];
    let params = [];

    if (nodeId) {
        conditions.push(`node_id = ?`);
        params.push(nodeId);
    }

    if (days) {
        conditions.push(`timestamp >= datetime('now', '-' || ? || ' days')`);
        params.push(days);
    }

    if (conditions.length > 0) {
        sql += ` WHERE ` + conditions.join(` AND `);
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
    // 🛡️ 強制設定安全上限，防止惡意請求過大資料量
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const { sql, params } = buildPacketQuery(req, `SELECT ${PACKET_LIST_COLS} FROM packet_logs`, { excludeTunnelPackets: true });
    const finalSql = `${sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;

    db.all(finalSql, [...params, limit, offset], (err, rows) => {
        if (err) {
            console.error('❌ API /api/packets SQL Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 🚀 全域封包總數統計（加快取）
app.get('/api/packets/count', withCache(), (req, res) => {
    const { sql, params } = buildPacketQuery(req, "SELECT COUNT(*) as count FROM packet_logs", { excludeTunnelPackets: true });
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: row?.count || 0 });
    });
});

// 📱 任務七：取得節點的真實公鑰與機型資訊
app.get('/api/node/:nodeId/contact-info', (req, res) => {
    const nodeId = req.params.nodeId;
    if (!nodeId) {
        return res.status(400).json({ error: 'Missing nodeId parameter' });
    }

    const sql = `
        SELECT payload_json FROM packet_logs 
        WHERE node_id = ? AND (portnum = 'NODEINFO_APP' OR portnum = '4' OR portnum = 4)
        ORDER BY timestamp DESC LIMIT 1
    `;

    db.get(sql, [nodeId], (err, row) => {
        if (err) {
            console.error(`❌ API /api/node/${nodeId}/contact-info Error:`, err.message);
            return res.status(500).json({ error: err.message });
        }

        if (!row || !row.payload_json) {
            return res.json({
                longName: '',
                shortName: '',
                hwModel: 0,
                publicKey: ''
            });
        }

        try {
            const payload = JSON.parse(row.payload_json);
            const user = payload.user || payload;
            
            const longName = user.longName || user.long_name || '';
            const shortName = user.shortName || user.short_name || '';
            const rawHwModel = user.hwModel || user.hw_model;
            const rawPubKey = user.publicKey || user.public_key;

            let hwModelInt = 0;
            if (rawHwModel) {
                if (typeof rawHwModel === 'number') {
                    hwModelInt = rawHwModel;
                } else if (typeof rawHwModel === 'string') {
                    const modelUpper = rawHwModel.toUpperCase();
                    if (modelUpper.includes('TBEAM') || modelUpper.includes('T-BEAM')) {
                        hwModelInt = 4;
                    } else if (modelUpper.includes('T_ECHO') || modelUpper.includes('TECHO')) {
                        hwModelInt = 15;
                    } else if (modelUpper.includes('HELIOT')) {
                        hwModelInt = 29;
                    } else if (modelUpper.includes('NANO_G1')) {
                        hwModelInt = 35;
                    } else if (modelUpper.includes('STATION')) {
                        hwModelInt = 25;
                    } else if (modelUpper.includes('TRACKER_T1000')) {
                        hwModelInt = 53;
                    } else {
                        hwModelInt = 4;
                    }
                }
            }

            let publicKeyBase64 = '';
            if (rawPubKey) {
                if (typeof rawPubKey === 'string') {
                    publicKeyBase64 = rawPubKey;
                } else if (rawPubKey.type === 'Buffer' && Array.isArray(rawPubKey.data)) {
                    publicKeyBase64 = Buffer.from(rawPubKey.data).toString('base64');
                } else if (rawPubKey.data && Array.isArray(rawPubKey.data)) {
                    publicKeyBase64 = Buffer.from(rawPubKey.data).toString('base64');
                } else if (Buffer.isBuffer(rawPubKey)) {
                    publicKeyBase64 = rawPubKey.toString('base64');
                } else if (Array.isArray(rawPubKey)) {
                    publicKeyBase64 = Buffer.from(rawPubKey).toString('base64');
                }
            }

            res.json({
                longName,
                shortName,
                hwModel: hwModelInt,
                publicKey: publicKeyBase64
            });
        } catch (parseErr) {
            console.error('❌ Failed to parse payload_json:', parseErr);
            res.json({
                longName: '',
                shortName: '',
                hwModel: 0,
                publicKey: ''
            });
        }
    });
});

// 🚀 新增：單一封包詳情（懶加載），包含 payload_json 和 raw_hex
app.get('/api/packets/:id', (req, res) => {
    db.get(`SELECT * FROM packet_logs WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        // 如果 payload_json 是字串先解析再回傳
        if (row.payload_json && typeof row.payload_json === 'string') {
            try { row.payload_json = JSON.parse(row.payload_json); } catch (_) { }
        }
        res.json(row);
    });
});

// 🚀 取得同一封包被哪些 gateway 收到（±60 秒同 node_id + portnum 的所有紀錄）
app.get('/api/packets/:id/gateways', (req, res) => {
    // 先查原始封包以取得 node_id, portnum, timestamp
    db.get(`SELECT node_id, portnum, timestamp, gateway_id FROM packet_logs WHERE id = ?`, [req.params.id], (err, origin) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!origin) return res.status(404).json({ error: 'Not found' });

        const sql = `
            SELECT gateway_id, snr, rssi, hops_away, hop_limit, hop_start, timestamp, id
            FROM packet_logs
            WHERE node_id = ?
              AND portnum = ?
              AND ABS(CAST((julianday(timestamp) - julianday(?)) * 86400 AS INTEGER)) <= 60
              AND gateway_id IS NOT NULL
              AND gateway_id != ''
            ORDER BY timestamp ASC
        `;
        db.all(sql, [origin.node_id, origin.portnum, origin.timestamp], (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json(rows);
        });
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

// 🛰️ Traceroute 多路徑渲染 API：回傳近 24 小時所有唯一 Traceroute 路徑（含每跳座標與 SNR）
app.get('/api/traceroute/paths', withCache(30 * 1000), (req, res) => {
    const sql = `
        SELECT node_id, gateway_id, payload_json, timestamp
        FROM packet_logs
        WHERE (portnum = '70' OR portnum = 'TRACEROUTE_APP')
          AND payload_json IS NOT NULL
          AND timestamp >= datetime('now', '-24 hours')
        ORDER BY timestamp DESC
        LIMIT 300
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // 依路由簽名去重，保留最新一筆
        const seenSigs = new Set();
        const parsed = [];
        const allNodeIds = new Set();

        for (const r of rows) {
            try {
                const p = JSON.parse(r.payload_json);
                const route = p.route || [];
                // snr_towards 以 0.25dB 為單位儲存，需除以 4 還原為 dB
                const snrTowards = (p.snr_towards || []).map(v => Math.round((v / 4) * 10) / 10);

                const routeHexIds = route.map(id => `!${(id >>> 0).toString(16).padStart(8, '0')}`);
                const fullPathIds = [r.node_id, ...routeHexIds, r.gateway_id].filter(Boolean).filter(id => id !== 'Unknown');

                if (fullPathIds.length < 2) continue;

                // 路由簽名 (去重)
                const sig = fullPathIds.join('->');
                if (seenSigs.has(sig)) continue;
                seenSigs.add(sig);

                fullPathIds.forEach(id => allNodeIds.add(id.toLowerCase()));
                parsed.push({ nodeIds: fullPathIds, snrTowards, timestamp: r.timestamp });

                if (parsed.length >= 25) break; // 最多 25 條唯一路徑
            } catch (e) { /* skip */ }
        }

        if (parsed.length === 0) return res.json([]);

        const allIds = Array.from(allNodeIds);
        const placeholders = allIds.map(() => '?').join(',');

        db.all(
            `SELECT node_id, short_name, long_name, latitude, longitude FROM nodes WHERE node_id IN (${placeholders})`,
            allIds,
            (err2, nodeRows) => {
                if (err2) return res.status(500).json({ error: err2.message });

                const nodeMap = new Map();
                nodeRows.forEach(n => nodeMap.set(n.node_id.toLowerCase(), n));

                const result = parsed.map((path, idx) => {
                    const hops = path.nodeIds.map((id, hopIdx) => {
                        const node = nodeMap.get(id.toLowerCase());
                        return {
                            nodeId: id,
                            name: node ? (node.short_name || node.long_name || id) : id,
                            latitude: node ? node.latitude : null,
                            longitude: node ? node.longitude : null,
                            // snrTowards[i] = 從 path[i] 到 path[i+1] 的 SNR
                            // 故 hop[i] 的「入站 SNR」是 snrTowards[i-1]
                            snr: hopIdx > 0 ? (path.snrTowards[hopIdx - 1] ?? null) : null
                        };
                    }).filter(h => h.latitude && h.longitude);

                    return {
                        id: `tr-${idx}`,
                        timestamp: path.timestamp,
                        hops,
                        totalHops: path.nodeIds.length - 2 // 不含起終點的中繼跳數
                    };
                }).filter(p => p.hops.length >= 2);

                res.json(result);
            }
        );
    });
});

// 🚀 核心升級：網格化覆蓋率聚合 API
// 🚀 效能優化：用 CTE 取代相關子查詢，消滅 N+1 問題
app.get('/api/coverage/griddata', withCache(30 * 1000), (req, res) => {
    // 🚀 CTE 實作方式（支援 timeStart / timeEnd 日期篩選）
    const timeConditions = [];
    const timeParams = [];
    if (req.query.timeStart) {
        timeConditions.push(`timestamp >= ?`);
        timeParams.push(req.query.timeStart);
    }
    if (req.query.timeEnd) {
        timeConditions.push(`timestamp <= ?`);
        timeParams.push(req.query.timeEnd);
    }
    const extraWhere = timeConditions.length > 0 ? `AND ${timeConditions.join(' AND ')}` : '';

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
              ${extraWhere}
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
    db.all(sql, timeParams, (err, rows) => {
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

// 提供給前端邏輯拓樸圖層的融合連線資料 (整合 NeighborInfo 與 Traceroute 路徑)
app.get('/api/topology/fusion-edges', (req, res) => {
    const queryNeighbors = `
        SELECT node_id as source_id, neighbor_id as target_id, 80 as confidence, 'NEIGHBOR_INFO' as method, snr
        FROM neighbors WHERE last_seen > datetime('now', '-2 days')
    `;

    db.all(queryNeighbors, [], (err, neighborRows) => {
        if (err) return res.status(500).json({ error: err.message });

        const edgesMap = new Map();

        // 1. 填入 NEIGHBOR_INFO（優先級最高，直接鄰居關係最可信）
        // 使用無向邊正準化 key，避免 A→B 和 B→A 重複建兩條線
        (neighborRows || []).forEach(r => {
            const [a, b] = r.source_id < r.target_id ? [r.source_id, r.target_id] : [r.target_id, r.source_id];
            const key = `${a}<->${b}`;
            // 若已存在同一對節點的邊，保留 SNR 較好（較高）的那筆
            if (!edgesMap.has(key) || (r.snr !== null && r.snr > (edgesMap.get(key).snr ?? -999))) {
                edgesMap.set(key, r);
            }
        });

        // 2. 從 7 天內 TRACEROUTE 封包解析跳轉鏈路
        const queryTraceroute = `
            SELECT node_id, gateway_id, payload_json, timestamp 
            FROM packet_logs 
            WHERE (portnum = '70' OR portnum = 'TRACEROUTE_APP')
              AND payload_json IS NOT NULL
              AND timestamp >= datetime('now', '-7 days')
            ORDER BY timestamp DESC LIMIT 500
        `;

        db.all(queryTraceroute, [], (tErr, traceRows) => {
            if (!tErr && Array.isArray(traceRows)) {
                traceRows.forEach(r => {
                    try {
                        const p = JSON.parse(r.payload_json);
                        const route = p.route || p.route_towards || [];
                        const snrTowards = p.snr_towards || [];

                        if (!Array.isArray(route)) return;

                        // 🔴 Bug fix #1: 過濾掉 0xFFFFFFFF (4294967295)
                        // 這是 Meshtastic 的「發送者自身」佔位符，不是真實中繼節點
                        // 若不過濾，會產生大量幽靈連線（ghost edges）
                        const SELF_ID = 4294967295;

                        // 🔴 Bug fix #2: 解析 snr_towards 的 SNR 值
                        // Meshtastic 將 SNR 編碼為 int8 * 4，-128 代表無效值
                        // snrTowards[i] 對應 route[i]（含 SELF_ID）收到前一跳的 SNR
                        const getSNR = (snrRaw) => {
                            if (snrRaw === undefined || snrRaw === null || snrRaw === -128) return null;
                            return Math.round((snrRaw / 4) * 10) / 10; // 除以 4 還原為 dB
                        };

                        // 建立 nodeId -> snr 對照表（使用含 SELF_ID 的原始索引來對齊 snrTowards）
                        const snrLookup = new Map();
                        route.forEach((rawId, idx) => {
                            if (rawId !== SELF_ID && idx < snrTowards.length) {
                                const hexId = `!${rawId.toString(16).padStart(8, '0')}`;
                                snrLookup.set(hexId, getSNR(snrTowards[idx]));
                            }
                        });
                        // gateway 對應的 SNR 是 snrTowards 陣列最後一個有效值
                        if (snrTowards.length > 0 && r.gateway_id) {
                            snrLookup.set(r.gateway_id, getSNR(snrTowards[snrTowards.length - 1]));
                        }

                        // 過濾 SELF_ID 後，建立乾淨的完整路徑
                        const routeIds = route
                            .filter(id => id !== SELF_ID)
                            .map(id => typeof id === 'number' ? `!${id.toString(16).padStart(8, '0')}` : String(id));

                        const fullPath = [r.node_id, ...routeIds, r.gateway_id].filter(id => {
                            return id && id !== 'Unknown' && !String(id).includes('undefined');
                        });

                        // 🔴 Bug fix #3: 去除自環（sender == gateway，路徑為空）
                        // 例如 !d3880f35 -> !d3880f35，這類封包無任何拓撲意義
                        // 注意：forEach 內不能用 continue，要用 return 跳過
                        if (fullPath.length < 2 || (fullPath.length === 2 && fullPath[0] === fullPath[1])) return;

                        // 去除重複的相鄰節點（某些封包 gateway_id 與 route 最後一個節點相同）
                        const dedupedPath = fullPath.filter((id, i) => i === 0 || id !== fullPath[i - 1]);


                        for (let i = 0; i < dedupedPath.length - 1; i++) {
                            const u = dedupedPath[i];
                            const v = dedupedPath[i + 1];
                            if (!u || !v || u === v) continue;

                            // v 節點收到 u 訊號的 SNR
                            const edgeSnr = snrLookup.get(v) ?? null;

                            // 🔑 使用「無向邊」正準化 key（字母序較小的放前面）
                            // 確保 A→B 和 B→A 對應同一條邊，每對直連節點只存一條
                            // 這樣地圖上就不會有重疊線，也不會有 A↔C 的幽靈連線
                            const [sortedA, sortedB] = u < v ? [u, v] : [v, u];
                            const key = `${sortedA}<->${sortedB}`;

                            if (!edgesMap.has(key)) {
                                edgesMap.set(key, {
                                    source_id: u,   // 保留原始方向給 tooltip 顯示用
                                    target_id: v,
                                    confidence: 90,
                                    method: 'TRACEROUTE',
                                    snr: edgeSnr
                                });
                            } else if (edgesMap.get(key).snr === null && edgeSnr !== null) {
                                edgesMap.get(key).snr = edgeSnr; // 補充缺失的 SNR
                            }
                        }
                    } catch (e) { /* 忽略解析錯誤的封包 */ }
                });
            }

            res.json(Array.from(edgesMap.values()));
        });
    });
});

// 取得單一節點的歷史封包紀錄
// 🚀 效能優化：只取列表需要欄位，加快取
app.get('/api/node/:nodeId/packets', withCache(), (req, res) => {
    const { sql, params } = buildPacketQuery(req, `SELECT ${PACKET_LIST_COLS} FROM packet_logs`);
    // 🛡️ 強制設定安全上限，防止有人請求過大資料量
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
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

// 📡 單一節點 RF 硬體衰退與健康度診斷 API (直連 0-Hop 封包過濾與時段聚合)
app.get('/api/node/:nodeId/rf-health', withCache(30 * 1000), (req, res) => {
    const nodeId = req.params.nodeId;
    // 🛡️ 限制天數最大為 30 天
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);

    const sql = `
        SELECT 
            STRFTIME('%m/%d %H:00', timestamp) AS time_label,
            ROUND(AVG(snr), 2) AS avg_snr,
            ROUND(AVG(rssi), 2) AS avg_rssi,
            COUNT(*) AS packet_count,
            MIN(timestamp) AS raw_time
        FROM packet_logs
        WHERE node_id = ?
          AND (
              (hop_start IS NOT NULL AND hop_limit IS NOT NULL AND (hop_start - hop_limit) = 0)
              OR hops_away = 0
          )
          AND snr IS NOT NULL AND snr BETWEEN -35 AND 35
          AND rssi IS NOT NULL AND rssi BETWEEN -150 AND 0
          AND timestamp >= datetime('now', '-${days} days')
        GROUP BY time_label
        ORDER BY raw_time ASC
    `;

    db.all(sql, [nodeId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
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

// ==========================================
// 🚀 全網宏觀戰情分析 API (Network Analytics)
// ==========================================

// 1. 全網 KPI 營運指標
app.get('/api/analytics/kpi', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '24h';
    let hours = 24;
    if (range === '7d') hours = 7 * 24;
    if (range === '30d') hours = 30 * 24;

    const sqlActive = `SELECT COUNT(*) as count FROM nodes WHERE last_seen >= datetime('now', '-${hours} hours')`;
    const sqlOffline = `SELECT COUNT(*) as count FROM nodes WHERE last_seen < datetime('now', '-48 hours') OR last_seen IS NULL`;
    const sqlGhost = `SELECT COUNT(*) as count FROM nodes WHERE last_seen >= datetime('now', '-${hours} hours') AND (latitude IS NULL OR longitude IS NULL OR latitude = 0 OR longitude = 0)`;
    const sqlLowBattery = `SELECT COUNT(*) as count FROM nodes WHERE voltage IS NOT NULL AND voltage > 0 AND voltage < 3.4`;

    Promise.all([
        new Promise((resolve, reject) => db.get(sqlActive, [], (err, r) => err ? reject(err) : resolve(r?.count || 0))),
        new Promise((resolve, reject) => db.get(sqlOffline, [], (err, r) => err ? reject(err) : resolve(r?.count || 0))),
        new Promise((resolve, reject) => db.get(sqlGhost, [], (err, r) => err ? reject(err) : resolve(r?.count || 0))),
        new Promise((resolve, reject) => db.get(sqlLowBattery, [], (err, r) => err ? reject(err) : resolve(r?.count || 0)))
    ]).then(([activeNodes, offlineNodes, ghostNodes, lowBatteryAlerts]) => {
        res.json({ activeNodes, offlineNodes, ghostNodes, lowBatteryAlerts });
    }).catch(err => {
        res.status(500).json({ error: err.message });
    });
});

// ⚡ [流式即時累加 & 快照歸檔] 核心函式
function computeAndSaveDaySummary(dateStr, callback) {
    const summarySql = `
        SELECT 
            (SELECT COUNT(DISTINCT node_id) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ?) as active_count,
            (SELECT COUNT(DISTINCT node_id) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND node_id NOT IN (SELECT node_id FROM nodes WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND latitude != 0 AND longitude != 0)) as ghost_count,
            (SELECT COALESCE(SUM(snr), 0) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND snr BETWEEN -35 AND 35) as snr_sum,
            (SELECT COUNT(snr) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND snr BETWEEN -35 AND 35) as snr_count,
            (SELECT COALESCE(SUM(rssi), 0) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND rssi BETWEEN -150 AND 0) as rssi_sum,
            (SELECT COUNT(rssi) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND rssi BETWEEN -150 AND 0) as rssi_count,
            (SELECT COALESCE(SUM(temperature), 0) FROM telemetry_data WHERE strftime('%Y-%m-%d', timestamp) = ? AND temperature IS NOT NULL) as temp_sum,
            (SELECT COUNT(temperature) FROM telemetry_data WHERE strftime('%Y-%m-%d', timestamp) = ? AND temperature IS NOT NULL) as temp_count,
            (SELECT COALESCE(SUM(humidity), 0) FROM telemetry_data WHERE strftime('%Y-%m-%d', timestamp) = ? AND humidity IS NOT NULL) as hum_sum,
            (SELECT COUNT(humidity) FROM telemetry_data WHERE strftime('%Y-%m-%d', timestamp) = ? AND humidity IS NOT NULL) as hum_count,
            (SELECT COUNT(*) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND (portnum = 'POSITION' OR portnum = '3' OR portnum = 'POSITION_APP')) as position_count,
            (SELECT COUNT(*) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND (portnum = 'TELEMETRY' OR portnum = '67' OR portnum = 'TELEMETRY_APP')) as telemetry_count,
            (SELECT COUNT(*) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND (portnum = 'TEXT_MESSAGE' OR portnum = '1' OR portnum = 'TEXT_MESSAGE_APP')) as text_count,
            (SELECT COUNT(*) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND (portnum = 'ROUTING' OR portnum = '5' OR portnum = 'ROUTING_APP')) as routing_count,
            (SELECT COUNT(*) FROM packet_logs WHERE strftime('%Y-%m-%d', timestamp) = ? AND portnum NOT IN ('POSITION','3','POSITION_APP','TELEMETRY','67','TELEMETRY_APP','TEXT_MESSAGE','1','TEXT_MESSAGE_APP','ROUTING','5','ROUTING_APP')) as other_count
    `;

    db.get(summarySql, Array(15).fill(dateStr), (err, row) => {
        if (err || !row) return callback && callback(err);
        const upsertSql = `
            INSERT INTO daily_analytics_summary 
            (date, active_count, ghost_count, snr_sum, snr_count, rssi_sum, rssi_count, temp_sum, temp_count, hum_sum, hum_count, position_count, telemetry_count, text_count, routing_count, other_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(date) DO UPDATE SET
                active_count = excluded.active_count,
                ghost_count = excluded.ghost_count,
                snr_sum = excluded.snr_sum,
                snr_count = excluded.snr_count,
                rssi_sum = excluded.rssi_sum,
                rssi_count = excluded.rssi_count,
                temp_sum = excluded.temp_sum,
                temp_count = excluded.temp_count,
                hum_sum = excluded.hum_sum,
                hum_count = excluded.hum_count,
                position_count = excluded.position_count,
                telemetry_count = excluded.telemetry_count,
                text_count = excluded.text_count,
                routing_count = excluded.routing_count,
                other_count = excluded.other_count,
                updated_at = CURRENT_TIMESTAMP
        `;
        db.run(upsertSql, [
            dateStr, row.active_count, row.ghost_count, row.snr_sum, row.snr_count,
            row.rssi_sum, row.rssi_count, row.temp_sum, row.temp_count,
            row.hum_sum, row.hum_count, row.position_count, row.telemetry_count,
            row.text_count, row.routing_count, row.other_count
        ], (uErr) => {
            if (callback) callback(uErr);
        });
    });
}

function bootstrapAnalyticsSummary() {
    console.log('⚡ [戰情快照] 檢查歷史快照完整度...');
    const todayStr = new Date().toISOString().split('T')[0];
    computeAndSaveDaySummary(todayStr);

    const sql = `
        SELECT DISTINCT strftime('%Y-%m-%d', timestamp) as date
        FROM packet_logs
        WHERE strftime('%Y-%m-%d', timestamp) NOT IN (SELECT date FROM daily_analytics_summary)
    `;
    db.all(sql, [], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            console.log('⚡ [戰情快照] 歷史快照已是最新，無需補算。');
            return;
        }
        console.log(`⚡ [戰情快照] 發現 ${rows.length} 天未彙總的歷史數據，開始自動歸檔補算...`);
        let done = 0;
        rows.forEach(r => {
            computeAndSaveDaySummary(r.date, () => {
                done++;
                if (done === rows.length) {
                    console.log('⚡ [戰情快照] 歷史數據補算完畢！所有天數均已歸檔快照。');
                }
            });
        });
    });
}

function recordLivePacketAnalytics(port, snr, rssi, temp, hum) {
    const today = new Date().toISOString().split('T')[0];
    let pType = 'other_count';
    const pStr = (port || '').toString();
    if (['POSITION', '3', 'POSITION_APP'].includes(pStr)) pType = 'position_count';
    else if (['TELEMETRY', '67', 'TELEMETRY_APP'].includes(pStr)) pType = 'telemetry_count';
    else if (['TEXT_MESSAGE', '1', 'TEXT_MESSAGE_APP'].includes(pStr)) pType = 'text_count';
    else if (['ROUTING', '5', '32', 'ROUTING_APP'].includes(pStr)) pType = 'routing_count';

    let validSnr = (snr !== null && snr !== undefined && snr >= -35 && snr <= 35) ? parseFloat(snr) : null;
    let validRssi = (rssi !== null && rssi !== undefined && rssi >= -150 && rssi <= 0) ? parseFloat(rssi) : null;
    let validTemp = (temp !== null && temp !== undefined) ? parseFloat(temp) : null;
    let validHum = (hum !== null && hum !== undefined) ? parseFloat(hum) : null;

    const sql = `
        INSERT INTO daily_analytics_summary (date, ${pType}, snr_sum, snr_count, rssi_sum, rssi_count, temp_sum, temp_count, hum_sum, hum_count)
        VALUES (?, 1, COALESCE(?, 0), CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END, COALESCE(?, 0), CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END, COALESCE(?, 0), CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END, COALESCE(?, 0), CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END)
        ON CONFLICT(date) DO UPDATE SET
            ${pType} = ${pType} + 1,
            snr_sum = snr_sum + COALESCE(?, 0),
            snr_count = snr_count + (CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END),
            rssi_sum = rssi_sum + COALESCE(?, 0),
            rssi_count = rssi_count + (CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END),
            temp_sum = temp_sum + COALESCE(?, 0),
            temp_count = temp_count + (CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END),
            hum_sum = hum_sum + COALESCE(?, 0),
            hum_count = hum_count + (CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END),
            updated_at = CURRENT_TIMESTAMP
    `;
    queueDbOp(sql, [
        today, validSnr, validSnr, validRssi, validRssi, validTemp, validTemp, validHum, validHum,
        validSnr, validSnr, validRssi, validRssi, validTemp, validTemp, validHum, validHum
    ]);
}

// 2. 歷史活躍度趨勢 (由 daily_analytics_summary 快照極速讀取)
app.get('/api/analytics/trends', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const todayStr = new Date().toISOString().split('T')[0];
    computeAndSaveDaySummary(todayStr, () => {
        const sql = `
            SELECT 
                date,
                active_count as activeNodes,
                ghost_count as ghostNodes
            FROM daily_analytics_summary
            WHERE date >= date('now', '-' || ? || ' days')
            ORDER BY date ASC
        `;

        db.all(sql, [days], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });
});

// 3. 網路角色分佈
app.get('/api/analytics/roles', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT COALESCE(role, 'CLIENT') as role, COUNT(*) as count
        FROM nodes
        GROUP BY COALESCE(role, 'CLIENT')
        ORDER BY count DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 4. 全網封包流量種類 (由 daily_analytics_summary 快照極速讀取)
app.get('/api/analytics/traffic', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            date,
            position_count as Position,
            telemetry_count as Telemetry,
            text_count as TextMessage,
            routing_count as Routing,
            other_count as Other
        FROM daily_analytics_summary
        WHERE date >= date('now', '-' || ? || ' days')
        ORDER BY date ASC
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 5. 全網平均 SNR / RSSI 歷史品質趨勢 (由 daily_analytics_summary 快照極速讀取)
app.get('/api/analytics/signal-health', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            date,
            CASE WHEN snr_count > 0 THEN ROUND(snr_sum / snr_count, 2) ELSE 0 END as avgSnr,
            CASE WHEN rssi_count > 0 THEN ROUND(rssi_sum / rssi_count, 1) ELSE 0 END as avgRssi
        FROM daily_analytics_summary
        WHERE date >= date('now', '-' || ? || ' days')
        ORDER BY date ASC
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 6. 跳數 (Hop Count) 傳遞分佈
app.get('/api/analytics/hop-distribution', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            CASE 
                WHEN (hop_start IS NOT NULL AND hop_limit IS NOT NULL AND (hop_start - hop_limit) <= 0) OR hops_away = 0 THEN '0 Hop (Direct)'
                WHEN (hop_start - hop_limit) = 1 OR hops_away = 1 THEN '1 Hop'
                WHEN (hop_start - hop_limit) = 2 OR hops_away = 2 THEN '2 Hops'
                ELSE '3+ Hops'
            END as hop_category,
            COUNT(*) as count
        FROM packet_logs
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY hop_category
        ORDER BY CASE 
            WHEN hop_category LIKE '0%' THEN 0
            WHEN hop_category LIKE '1%' THEN 1
            WHEN hop_category LIKE '2%' THEN 2
            ELSE 3
        END ASC
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 7. 24 小時時段熱門活動分佈
app.get('/api/analytics/hourly-activity', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            strftime('%H', timestamp) as hour,
            COUNT(*) as count
        FROM packet_logs
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY strftime('%H', timestamp)
        ORDER BY hour ASC
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 確保 00~23 小時完整包含
        const resultMap = new Map();
        for (let h = 0; h < 24; h++) {
            const hStr = h.toString().padStart(2, '0');
            resultMap.set(hStr, { hour: `${hStr}:00`, count: 0 });
        }
        (rows || []).forEach(r => {
            if (r.hour && resultMap.has(r.hour)) {
                resultMap.get(r.hour).count = r.count;
            }
        });
        res.json(Array.from(resultMap.values()));
    });
});

// 8. 硬體晶片與型號統計
app.get('/api/analytics/hardware-models', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT COALESCE(hw_model, 'UNKNOWN') as model, COUNT(*) as count
        FROM nodes
        GROUP BY COALESCE(hw_model, 'UNKNOWN')
        ORDER BY count DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 9. 韌體版本升級進度 (離散官方版本系列與主要版號聚合)
app.get('/api/analytics/firmware-versions', withCache(60 * 1000), (req, res) => {
    const sql = `SELECT COALESCE(firmware_version, 'Unknown') as fw_ver FROM nodes`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const seriesMap = new Map();
        const exactMap = new Map();

        (rows || []).forEach(r => {
            let rawFw = r.fw_ver;
            if (!rawFw) return;

            let matchSeries = rawFw.match(/^(\d+\.\d+)/);
            let seriesName = matchSeries ? 'v' + matchSeries[1] + '.x' : 'Other';
            seriesMap.set(seriesName, (seriesMap.get(seriesName) || 0) + 1);

            let matchExact = rawFw.match(/^(\d+\.\d+\.\d+)/);
            let exactName = matchExact ? matchExact[1] : rawFw;
            exactMap.set(exactName, (exactMap.get(exactName) || 0) + 1);
        });

        // 大版本系列 (v2.7.x, v2.6.x ...)
        const series = Array.from(seriesMap.entries())
            .map(([version, count]) => ({ version, count }))
            .sort((a, b) => b.count - a.count);

        // 詳細 Top 5 版號 + 其他 (Other)
        const sortedExact = Array.from(exactMap.entries())
            .sort((a, b) => b[1] - a[1]);
        const topExact = sortedExact.slice(0, 5).map(([version, count]) => ({ version, count }));
        const otherCount = sortedExact.slice(5).reduce((sum, item) => sum + item[1], 0);
        if (otherCount > 0) {
            topExact.push({ version: 'Other', count: otherCount });
        }

        res.json({
            series,
            exact: topExact,
            // 保持向後相容
            versions: topExact
        });
    });
});

// 10. 全網氣候環境遙測趨勢 (由 daily_analytics_summary 快照極速讀取)
app.get('/api/analytics/environment-trends', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            date,
            CASE WHEN temp_count > 0 THEN ROUND(temp_sum / temp_count, 1) ELSE null END as avgTemp,
            CASE WHEN hum_count > 0 THEN ROUND(hum_sum / hum_count, 1) ELSE null END as avgHumidity
        FROM daily_analytics_summary
        WHERE date >= date('now', '-' || ? || ' days')
        ORDER BY date ASC
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// ==========================================
// ⛅ 中央氣象署 (CWA) 觀測站 API 串接模組
// ==========================================
const https = require('https');

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半徑 (公里)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function fetchAndSaveCWAData() {
    const cwaKey = process.env.CWA_API_KEY;
    if (!cwaKey) {
        console.warn('⚠️ [CWA] 未配置 CWA_API_KEY 環境變數，跳過中央氣象署觀測站資料抓取');
        return;
    }

    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001?Authorization=${cwaKey}`;
    https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                const stations = json.records?.Station || [];
                if (stations.length === 0) return;

                let updatedCount = 0;
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    const stmt = db.prepare(`
                        INSERT INTO cwa_weather_stations 
                        (station_id, station_name, county, town, latitude, longitude, temperature, humidity, weather, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(station_id) DO UPDATE SET
                            temperature = excluded.temperature,
                            humidity = excluded.humidity,
                            weather = excluded.weather,
                            updated_at = CURRENT_TIMESTAMP
                    `);

                    stations.forEach(s => {
                        const id = s.StationId;
                        const name = s.StationName;
                        const county = s.GeoInfo?.CountyName || '';
                        const town = s.GeoInfo?.TownName || '';
                        const coords = s.GeoInfo?.Coordinates?.find(c => c.CoordinateName === 'WGS84');
                        const lat = parseFloat(coords?.StationLatitude || s.Latitude);
                        const lng = parseFloat(coords?.StationLongitude || s.Longitude);

                        const tempRaw = s.WeatherElement?.AirTemperature;
                        const humRaw = s.WeatherElement?.RelativeHumidity;
                        const weather = s.WeatherElement?.Weather || '';

                        let temp = (tempRaw !== undefined && tempRaw !== '-99' && tempRaw !== -99) ? parseFloat(tempRaw) : null;
                        let hum = (humRaw !== undefined && humRaw !== '-99' && humRaw !== -99) ? parseFloat(humRaw) : null;

                        if (id && name && !isNaN(lat) && !isNaN(lng)) {
                            stmt.run([id, name, county, town, lat, lng, temp, hum, weather]);
                            updatedCount++;
                        }
                    });
                    stmt.finalize();
                    db.run('COMMIT', (err) => {
                        if (!err) {
                            console.log(`⛅ [中央氣象署 API] 成功更新 ${updatedCount} 個台灣官方氣象站即時觀測數據！`);
                        }
                    });
                });
            } catch (e) {
                console.error('❌ CWA API 解析失敗:', e.message);
            }
        });
    }).on('error', err => {
        console.error('❌ CWA API 請求失敗:', err.message);
    });
}

// 每 15 分鐘自動刷新中央氣象署氣象資料
cron.schedule('*/15 * * * *', () => {
    fetchAndSaveCWAData();
});

// API 1: 取得最近的官方氣象站觀測資料與溫差比對
app.get('/api/cwa/nearest', (req, res) => {
    let { lat, lng, node_id } = req.query;

    const findNearest = (targetLat, targetLng, nodeObj) => {
        db.all(`SELECT * FROM cwa_weather_stations WHERE temperature IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL`, [], (err, stations) => {
            if (err || !stations || stations.length === 0) {
                return res.json({ nearestStation: null, nodeTemp: nodeObj?.temperature, nodeHumidity: nodeObj?.humidity });
            }

            let nearest = null;
            let minDistance = Infinity;

            stations.forEach(st => {
                const dist = calculateHaversineDistance(targetLat, targetLng, st.latitude, st.longitude);
                if (dist < minDistance) {
                    minDistance = dist;
                    nearest = st;
                }
            });

            if (nearest) {
                nearest.distance_km = Math.round(minDistance * 100) / 100;
            }

            const nTemp = nodeObj?.temperature != null ? parseFloat(nodeObj.temperature) : null;
            const nHum = nodeObj?.humidity != null ? parseFloat(nodeObj.humidity) : null;

            const deltaTemp = (nTemp != null && nearest?.temperature != null) ? Math.round((nTemp - nearest.temperature) * 10) / 10 : null;
            const deltaHum = (nHum != null && nearest?.humidity != null) ? Math.round(nHum - nearest.humidity) : null;

            res.json({
                nearestStation: nearest,
                nodeTemp: nTemp,
                nodeHumidity: nHum,
                deltaTemp,
                deltaHum
            });
        });
    };

    if (node_id) {
        db.get(`SELECT * FROM nodes WHERE node_id = ?`, [node_id], (err, node) => {
            if (node && node.latitude && node.longitude) {
                findNearest(node.latitude, node.longitude, node);
            } else if (lat && lng) {
                findNearest(parseFloat(lat), parseFloat(lng), node || {});
            } else {
                res.status(400).json({ error: 'Node has no GPS coordinates' });
            }
        });
    } else if (lat && lng) {
        findNearest(parseFloat(lat), parseFloat(lng), {});
    } else {
        res.status(400).json({ error: 'Missing lat/lng or node_id parameters' });
    }
});

// API 2: 取得 CWA 官方全台平均 vs Mesh 網路平均 (舊版，保留向下相容)
app.get('/api/analytics/cwa-comparison', withCache(60 * 1000), (req, res) => {
    db.get(`SELECT ROUND(AVG(temperature), 1) as cwaAvgTemp, ROUND(AVG(humidity), 1) as cwaAvgHumidity FROM cwa_weather_stations WHERE temperature IS NOT NULL`, [], (err, cwaRes) => {
        db.get(`SELECT ROUND(AVG(temperature), 1) as meshAvgTemp, ROUND(AVG(humidity), 1) as meshAvgHumidity FROM telemetry_data WHERE temperature IS NOT NULL AND timestamp >= datetime('now', '-24 hours')`, [], (mErr, meshRes) => {
            const cwaTemp = cwaRes?.cwaAvgTemp || 26.5;
            const cwaHum = cwaRes?.cwaAvgHumidity || 75.0;
            const meshTemp = meshRes?.meshAvgTemp || 28.1;
            const meshHum = meshRes?.meshAvgHumidity || 72.0;

            res.json({
                cwaAvgTemp: cwaTemp,
                cwaAvgHumidity: cwaHum,
                meshAvgTemp: meshTemp,
                meshAvgHumidity: meshHum,
                tempDelta: Math.round((meshTemp - cwaTemp) * 10) / 10,
                humidityDelta: Math.round(meshHum - cwaHum)
            });
        });
    });
});

// ==========================================
// 📊 API 2.1: 跳數傳播深度分佈 (Hop Count Distribution & 診斷)
// ==========================================
app.get('/api/analytics/hop-distribution', withCache(60 * 1000), (req, res) => {
    const sqlActual = `
        SELECT 
            COALESCE(hops_away, (hop_start - hop_limit)) as hop,
            COUNT(*) as count
        FROM packet_logs
        WHERE timestamp >= datetime('now', '-24 hours')
          AND (hops_away IS NOT NULL OR (hop_start IS NOT NULL AND hop_limit IS NOT NULL))
          AND COALESCE(hops_away, (hop_start - hop_limit)) >= 0
        GROUP BY hop
        ORDER BY hop ASC
    `;

    const sqlConfigured = `
        SELECT 
            hop_limit as hop,
            COUNT(*) as count
        FROM nodes
        WHERE hop_limit IS NOT NULL AND hop_limit > 0
          AND last_seen >= datetime('now', '-7 days')
        GROUP BY hop_limit
        ORDER BY hop_limit ASC
    `;

    db.all(sqlActual, [], (err, actualRows) => {
        db.all(sqlConfigured, [], (cErr, configuredRows) => {
            let actualTotal = 0, actualSum = 0;
            (actualRows || []).forEach(r => {
                actualTotal += r.count;
                actualSum += r.hop * r.count;
            });
            const avgActualHops = actualTotal > 0 ? Math.round((actualSum / actualTotal) * 10) / 10 : 0;

            let confTotal = 0, confSum = 0;
            (configuredRows || []).forEach(r => {
                confTotal += r.count;
                confSum += r.hop * r.count;
            });
            const avgConfiguredHops = confTotal > 0 ? Math.round((confSum / confTotal) * 10) / 10 : 0;

            const diff = Math.round((avgConfiguredHops - avgActualHops) * 10) / 10;
            let recommendation = null;
            if (avgConfiguredHops > 0 && avgActualHops > 0 && diff >= 1.2) {
                recommendation = `💡 網路診斷提醒：全網封包實際傳播深度平均僅 ${avgActualHops} 跳，但節點預設的 Hop Limit 限額平均高達 ${avgConfiguredHops} 跳（相差 ${diff} 跳）。建議引導用戶將 Hop Limit 降低至 2~3，以大幅減少無謂重複廣播與頻道碰撞，有效節省 Mesh 頻寬！`;
            } else {
                recommendation = `✅ 網路診斷良好：封包實際跳轉數 (${avgActualHops} 跳) 與節點 Hop 限額設定 (${avgConfiguredHops} 跳) 匹配良好，頻寬利用順暢。`;
            }

            res.json({
                actualHops: actualRows || [],
                configuredHops: configuredRows || [],
                avgActualHops,
                avgConfiguredHops,
                diff,
                recommendation
            });
        });
    });
});

// ==========================================
// 📊 API 2.2: 24 小時熱點活動高峰 (依封包種類堆疊)
// ==========================================
app.get('/api/analytics/hourly-peak-stacked', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            strftime('%H', timestamp) as hour,
            portnum,
            COUNT(*) as count
        FROM packet_logs
        WHERE timestamp >= datetime('now', '-24 hours')
        GROUP BY hour, portnum
        ORDER BY hour ASC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const hoursMap = {};
        for (let i = 0; i < 24; i++) {
            const h = i.toString().padStart(2, '0');
            hoursMap[h] = { hour: `${h}:00`, text: 0, position: 0, telemetry: 0, routing: 0, admin: 0, other: 0, total: 0 };
        }

        (rows || []).forEach(r => {
            const h = r.hour;
            if (!hoursMap[h]) return;
            const cnt = r.count;
            const p = (r.portnum || '').toString();
            hoursMap[h].total += cnt;

            if (['TEXT_MESSAGE', '1', 'TEXT_MESSAGE_APP'].includes(p)) hoursMap[h].text += cnt;
            else if (['POSITION', '3', 'POSITION_APP'].includes(p)) hoursMap[h].position += cnt;
            else if (['TELEMETRY', '67', 'TELEMETRY_APP'].includes(p)) hoursMap[h].telemetry += cnt;
            else if (['ROUTING', '5', '32', 'ROUTING_APP'].includes(p)) hoursMap[h].routing += cnt;
            else if (['ADMIN', '6', 'ADMIN_APP'].includes(p)) hoursMap[h].admin += cnt;
            else hoursMap[h].other += cnt;
        });

        res.json(Object.values(hoursMap));
    });
});

// ==========================================
// 📊 API 2.3: 頻道佔用率 (CU) 分級統計
// ==========================================
app.get('/api/analytics/cu-distribution', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            t.node_id,
            t.channel_utilization as cu,
            n.long_name,
            n.short_name,
            n.last_seen
        FROM telemetry_data t
        INNER JOIN (
            SELECT node_id, MAX(timestamp) as max_ts
            FROM telemetry_data
            WHERE channel_utilization IS NOT NULL AND timestamp >= datetime('now', '-24 hours')
            GROUP BY node_id
        ) latest ON t.node_id = latest.node_id AND t.timestamp = latest.max_ts
        INNER JOIN nodes n ON t.node_id = n.node_id
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const critical = [];
        const congested = [];
        const normal = [];
        const low = [];
        let sumCU = 0;

        (rows || []).forEach(r => {
            const rawCU = r.cu ?? r.channel_utilization ?? 0;
            const cu = Math.round(rawCU * 10) / 10;
            sumCU += cu;
            const item = { nodeId: r.node_id, name: r.long_name || r.short_name || r.node_id, cu };
            if (cu >= 25) critical.push(item);
            else if (cu >= 20) congested.push(item);
            else if (cu >= 5) normal.push(item);
            else low.push(item);
        });

        const total = (rows || []).length;
        const avgCU = total > 0 ? Math.round((sumCU / total) * 10) / 10 : 0;

        res.json({
            totalNodes: total,
            avgCU,
            tiers: {
                critical: { count: critical.length, pct: total > 0 ? Math.round((critical.length / total) * 100) : 0, nodes: critical },
                congested: { count: congested.length, pct: total > 0 ? Math.round((congested.length / total) * 100) : 0, nodes: congested },
                normal: { count: normal.length, pct: total > 0 ? Math.round((normal.length / total) * 100) : 0, nodes: normal },
                low: { count: low.length, pct: total > 0 ? Math.round((low.length / total) * 100) : 0, nodes: low }
            }
        });
    });
});

// ==========================================
// 📡 API 2.3.1: 發射空口佔用率 (AirUtil TX) 分級與 Top 榜
// ==========================================
app.get('/api/analytics/air-util-distribution', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            t.node_id,
            t.air_util_tx,
            n.long_name,
            n.short_name,
            n.last_seen
        FROM telemetry_data t
        INNER JOIN (
            SELECT node_id, MAX(timestamp) as max_ts
            FROM telemetry_data
            WHERE air_util_tx IS NOT NULL AND timestamp >= datetime('now', '-24 hours')
            GROUP BY node_id
        ) latest ON t.node_id = latest.node_id AND t.timestamp = latest.max_ts
        INNER JOIN nodes n ON t.node_id = n.node_id
        ORDER BY t.air_util_tx DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const high = [];
        const medium = [];
        const low = [];
        let sumTx = 0;

        (rows || []).forEach(r => {
            const tx = Math.round(r.air_util_tx * 10) / 10;
            sumTx += tx;
            const item = { nodeId: r.node_id, name: r.long_name || r.short_name || r.node_id, tx };
            if (tx > 5) high.push(item);
            else if (tx >= 2.5) medium.push(item);
            else low.push(item);
        });

        const total = (rows || []).length;
        const avgTx = total > 0 ? Math.round((sumTx / total) * 10) / 10 : 0;
        const topNodes = (rows || []).slice(0, 10).map(r => ({
            nodeId: r.node_id,
            name: r.long_name || r.short_name || r.node_id,
            tx: Math.round(r.air_util_tx * 10) / 10
        }));

        res.json({
            totalNodes: total,
            avgTx,
            topNodes,
            tiers: {
                high: { count: high.length, pct: total > 0 ? Math.round((high.length / total) * 100) : 0, nodes: high },
                medium: { count: medium.length, pct: total > 0 ? Math.round((medium.length / total) * 100) : 0, nodes: medium },
                low: { count: low.length, pct: total > 0 ? Math.round((low.length / total) * 100) : 0, nodes: low }
            }
        });
    });
});

// ==========================================
// 🏆 API 2.3.2: 最狂 MQTT 閘道與直連覆蓋分析
// ==========================================
app.get('/api/analytics/top-gateways', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            p.gateway_id,
            n.long_name,
            n.short_name,
            COUNT(p.id) as packet_count,
            COUNT(DISTINCT CASE WHEN p.hops_away = 0 OR p.hop_limit = p.hop_start THEN p.node_id END) as direct_nodes_count,
            COUNT(DISTINCT p.node_id) as total_unique_nodes,
            ROUND(AVG(p.snr), 1) as avg_snr,
            MAX(p.timestamp) as last_seen
        FROM packet_logs p
        LEFT JOIN nodes n ON p.gateway_id = n.node_id
        WHERE p.gateway_id IS NOT NULL AND p.gateway_id != '' AND p.timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY p.gateway_id
        ORDER BY packet_count DESC
        LIMIT 20
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const list = (rows || []).map(r => ({
            gatewayId: r.gateway_id,
            name: r.long_name || r.short_name || r.gateway_id,
            packetCount: r.packet_count,
            directNodesCount: r.direct_nodes_count,
            totalUniqueNodes: r.total_unique_nodes,
            avgSnr: r.avg_snr,
            lastSeen: r.last_seen
        }));
        res.json(list);
    });
});

// ==========================================
// 🔄 API 2.3.3: 封包重複率與傳播效率分析
// ==========================================
app.get('/api/analytics/duplicate-stats', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            COUNT(*) as total_records,
            COUNT(DISTINCT (node_id || '_' || portnum || '_' || strftime('%Y-%m-%d %H:%M', timestamp))) as unique_events
        FROM packet_logs
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
    `;

    db.get(sql, [days], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const total = row ? row.total_records : 0;
        const unique = row ? row.unique_events : 0;
        const duplicates = Math.max(0, total - unique);
        const duplicateRate = total > 0 ? Math.round((duplicates / total) * 1000) / 10 : 0;
        const efficiencyScore = Math.max(0, Math.round(100 - duplicateRate));

        res.json({
            totalPackets: total,
            uniquePackets: unique,
            duplicatePackets: duplicates,
            duplicateRatePct: duplicateRate,
            efficiencyScore
        });
    });
});

// ==========================================
// 🌐 API 2.3.4: RF 純無線 vs MQTT 橋接流量比例
// ==========================================
app.get('/api/analytics/traffic-source-ratio', withCache(60 * 1000), (req, res) => {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '24h') days = 1;
    if (range === '30d') days = 30;

    const sql = `
        SELECT 
            CASE 
                WHEN source IS NOT NULL AND source != '' AND source NOT LIKE '%MQTT%' THEN source
                WHEN topic LIKE '%/mqtt/%' OR gateway_id IS NOT NULL THEN 'MQTT Gateway'
                ELSE 'RF Native'
            END as source_category,
            COUNT(*) as count
        FROM packet_logs
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY source_category
        ORDER BY count DESC
    `;

    db.all(sql, [days], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// ==========================================
// 🔋 API 2.3.5: 電池與太陽能供電健康分佈
// ==========================================
app.get('/api/analytics/power-health', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            node_id,
            long_name,
            short_name,
            battery_level,
            voltage,
            last_seen
        FROM nodes
        WHERE battery_level IS NOT NULL AND last_seen >= datetime('now', '-48 hours')
        ORDER BY battery_level ASC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const critical = [];
        const warning = [];
        const healthy = [];
        let sumBat = 0;

        (rows || []).forEach(r => {
            const lvl = Math.round(r.battery_level);
            sumBat += lvl;
            const item = { nodeId: r.node_id, name: r.long_name || r.short_name || r.node_id, battery: lvl, voltage: r.voltage ? (Math.round(r.voltage * 100) / 100) : null };
            if (lvl < 20) critical.push(item);
            else if (lvl <= 50) warning.push(item);
            else healthy.push(item);
        });

        const total = (rows || []).length;
        const avgBattery = total > 0 ? Math.round(sumBat / total) : 0;

        res.json({
            totalNodes: total,
            avgBattery,
            tiers: {
                critical: { count: critical.length, pct: total > 0 ? Math.round((critical.length / total) * 100) : 0, nodes: critical },
                warning: { count: warning.length, pct: total > 0 ? Math.round((warning.length / total) * 100) : 0, nodes: warning },
                healthy: { count: healthy.length, pct: total > 0 ? Math.round((healthy.length / total) * 100) : 0, nodes: healthy }
            }
        });
    });
});

// ==========================================
// 🕸️ API 2.3.6: 網狀拓撲密度與核心樞紐榜
// ==========================================
app.get('/api/analytics/mesh-interconnectivity', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            n1.node_id,
            nd.long_name,
            nd.short_name,
            COUNT(DISTINCT n1.neighbor_id) as neighbor_count,
            ROUND(AVG(n1.snr), 1) as avg_snr
        FROM neighbors n1
        LEFT JOIN nodes nd ON n1.node_id = nd.node_id
        WHERE n1.last_seen >= datetime('now', '-48 hours')
        GROUP BY n1.node_id
        ORDER BY neighbor_count DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const hubNodes = (rows || []).slice(0, 10).map(r => ({
            nodeId: r.node_id,
            name: r.long_name || r.short_name || r.node_id,
            neighborCount: r.neighbor_count,
            avgSnr: r.avg_snr
        }));

        let totalNeighbors = 0;
        (rows || []).forEach(r => { totalNeighbors += r.neighbor_count; });

        const reportingNodes = (rows || []).length;
        const avgNeighborsPerNode = reportingNodes > 0 ? Math.round((totalNeighbors / reportingNodes) * 10) / 10 : 0;

        res.json({
            reportingNodes,
            avgNeighborsPerNode,
            hubNodes
        });
    });
});

// ==========================================
// ⚠️ API 2.3.7: 臨界弱訊號與訊號波動警告
// ==========================================
app.get('/api/analytics/weak-signal-alerts', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            p.node_id,
            n.long_name,
            n.short_name,
            ROUND(AVG(p.snr), 1) as avg_snr,
            MIN(p.snr) as min_snr,
            MAX(p.snr) as max_snr,
            COUNT(p.id) as packet_count,
            MAX(p.timestamp) as last_seen
        FROM packet_logs p
        INNER JOIN nodes n ON p.node_id = n.node_id
        WHERE p.snr IS NOT NULL AND p.snr BETWEEN -35 AND 35
          AND p.timestamp >= datetime('now', '-24 hours')
        GROUP BY p.node_id
        HAVING avg_snr < -10 OR min_snr < -15
        ORDER BY avg_snr ASC
        LIMIT 20
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const list = (rows || []).map(r => ({
            nodeId: r.node_id,
            name: r.long_name || r.short_name || r.node_id,
            avgSnr: r.avg_snr,
            minSnr: r.min_snr,
            maxSnr: r.max_snr,
            packetCount: r.packet_count,
            lastSeen: r.last_seen
        }));
        res.json({
            count: list.length,
            nodes: list
        });
    });
});

// ==========================================
// ☀️ API 2.3.8: 太陽能板充電狀態與光照效能榜
// ==========================================
app.get('/api/analytics/solar-charging-health', withCache(60 * 1000), (req, res) => {
    const sql = `
        SELECT 
            t.node_id,
            t.voltage,
            t.current,
            t.battery_level,
            n.long_name,
            n.short_name,
            t.timestamp
        FROM telemetry_data t
        INNER JOIN (
            SELECT node_id, MAX(timestamp) as max_ts
            FROM telemetry_data
            WHERE voltage IS NOT NULL AND voltage > 0 AND timestamp >= datetime('now', '-24 hours')
            GROUP BY node_id
        ) latest ON t.node_id = latest.node_id AND t.timestamp = latest.max_ts
        INNER JOIN nodes n ON t.node_id = n.node_id
        ORDER BY t.voltage DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let chargingCount = 0;
        let sumVolts = 0;
        let validVoltsCount = 0;

        const list = (rows || []).map(r => {
            const v = r.voltage || 0;
            if (v > 0) {
                sumVolts += v;
                validVoltsCount++;
            }
            const isCharging = (v >= 4.15) || (r.current && r.current > 0);
            if (isCharging) chargingCount++;

            return {
                nodeId: r.node_id,
                name: r.long_name || r.short_name || r.node_id,
                voltage: Math.round(v * 100) / 100,
                battery: r.battery_level ? Math.round(r.battery_level) : null,
                isCharging
            };
        });

        const avgVoltage = validVoltsCount > 0 ? Math.round((sumVolts / validVoltsCount) * 100) / 100 : 0;
        const topSolarNodes = list.slice(0, 10);

        res.json({
            totalSolarNodes: list.length,
            chargingCount,
            avgVoltage,
            topSolarNodes
        });
    });
});

// ==========================================
// 🛰️ API 2.4: 閘道器經手節點清單
// ==========================================
app.get('/api/gateway/relayed-nodes/:gatewayId', (req, res) => {
    const gatewayId = req.params.gatewayId;
    const sql = `
        SELECT 
            p.node_id,
            n.long_name,
            n.short_name,
            n.latitude,
            n.longitude,
            COUNT(p.id) as packet_count,
            MAX(p.timestamp) as last_activity,
            ROUND(AVG(p.snr), 1) as avg_snr,
            ROUND(AVG(p.rssi), 0) as avg_rssi
        FROM packet_logs p
        LEFT JOIN nodes n ON p.node_id = n.node_id
        WHERE p.gateway_id = ? AND p.timestamp >= datetime('now', '-24 hours')
        GROUP BY p.node_id
        ORDER BY last_activity DESC
    `;

    db.all(sql, [gatewayId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            gatewayId,
            relayedCount: (rows || []).length,
            totalPackets: (rows || []).reduce((sum, r) => sum + r.packet_count, 0),
            relayedNodes: rows || []
        });
    });
});

// ==========================================
// 🎯 API 3: 精準地理配對比對 (Per-Node Nearest Station)
// 每個 Mesh 節點 → 找最近 CWA 站 → 個別 ΔT / ΔH → 按縣市分區聚合
// ==========================================
app.get('/api/analytics/cwa-node-comparison', withCache(60 * 1000), (req, res) => {
    // 步驟 1: 取得所有有 GPS 座標的 Mesh 節點及其最新遙測數據
    const meshSql = `
        SELECT 
            n.node_id,
            n.long_name,
            n.short_name,
            n.latitude,
            n.longitude,
            t.temperature as node_temp,
            t.humidity as node_humidity,
            t.timestamp as telemetry_time
        FROM nodes n
        INNER JOIN (
            SELECT node_id, temperature, humidity, timestamp,
                   ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY timestamp DESC) as rn
            FROM telemetry_data
            WHERE temperature IS NOT NULL
              AND timestamp >= datetime('now', '-24 hours')
        ) t ON n.node_id = t.node_id AND t.rn = 1
        WHERE n.latitude IS NOT NULL 
          AND n.longitude IS NOT NULL
          AND n.latitude != 0
          AND n.longitude != 0
    `;

    db.all(meshSql, [], (meshErr, meshNodes) => {
        if (meshErr) return res.status(500).json({ error: meshErr.message });
        if (!meshNodes || meshNodes.length === 0) {
            return res.json({ nodeComparisons: [], regionSummary: [], totalNodes: 0 });
        }

        // 步驟 2: 取得所有有效 CWA 測站 (只取平地/丘陵站，排除高山)
        // 策略：不用高度過濾（DB沒有高度欄位），改用溫度合理性過濾 (< 10°C 的明顯高山站在夏天才會出現)
        const cwaSql = `
            SELECT station_id, station_name, county, town, latitude, longitude, temperature, humidity, weather
            FROM cwa_weather_stations
            WHERE temperature IS NOT NULL
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
        `;

        db.all(cwaSql, [], (cwaErr, cwaStations) => {
            if (cwaErr) return res.status(500).json({ error: cwaErr.message });
            if (!cwaStations || cwaStations.length === 0) {
                return res.json({ nodeComparisons: [], regionSummary: [], totalNodes: 0, cwaReady: false });
            }

            // 步驟 3: 對每個 Mesh 節點找最近的 CWA 站
            const nodeComparisons = [];

            for (const node of meshNodes) {
                let nearest = null;
                let minDist = Infinity;

                for (const st of cwaStations) {
                    const dist = calculateHaversineDistance(
                        node.latitude, node.longitude,
                        st.latitude, st.longitude
                    );
                    if (dist < minDist) {
                        minDist = dist;
                        nearest = st;
                    }
                }

                if (!nearest) continue;

                const nodeTemp = parseFloat(node.node_temp);
                const cwaTemp = parseFloat(nearest.temperature);
                const nodeHum = node.node_humidity != null ? parseFloat(node.node_humidity) : null;
                const cwaHum = nearest.humidity != null ? parseFloat(nearest.humidity) : null;

                const deltaTemp = isNaN(nodeTemp) || isNaN(cwaTemp) ? null : Math.round((nodeTemp - cwaTemp) * 10) / 10;
                const deltaHum = (nodeHum != null && cwaHum != null) ? Math.round(nodeHum - cwaHum) : null;

                nodeComparisons.push({
                    nodeId: node.node_id,
                    nodeName: node.long_name || node.short_name || node.node_id,
                    nodeShortName: node.short_name,
                    nodeLat: node.latitude,
                    nodeLng: node.longitude,
                    nodeTemp: isNaN(nodeTemp) ? null : Math.round(nodeTemp * 10) / 10,
                    nodeHumidity: nodeHum != null ? Math.round(nodeHum * 10) / 10 : null,
                    cwaStationId: nearest.station_id,
                    cwaStationName: nearest.station_name,
                    cwaCounty: nearest.county,
                    cwaTown: nearest.town,
                    cwaLat: nearest.latitude,
                    cwaLng: nearest.longitude,
                    cwaTemp: isNaN(cwaTemp) ? null : Math.round(cwaTemp * 10) / 10,
                    cwaHumidity: cwaHum,
                    cwaWeather: nearest.weather,
                    distanceKm: Math.round(minDist * 100) / 100,
                    deltaTemp,
                    deltaHum,
                    anomaly: deltaTemp !== null && Math.abs(deltaTemp) > 3 // 超過 3°C 為異常
                });
            }

            // 步驟 4: 按 CWA 縣市分區聚合統計
            const regionMap = {};
            for (const item of nodeComparisons) {
                const county = item.cwaCounty || '未知縣市';
                if (!regionMap[county]) {
                    regionMap[county] = {
                        county,
                        nodeCount: 0,
                        validDeltaCount: 0,
                        cwaTempSum: 0,
                        cwaTempCount: 0,
                        meshTempSum: 0,
                        meshTempCount: 0,
                        weatherList: [],
                        deltaTempSum: 0,
                        deltaHumSum: 0,
                        maxDeltaTemp: -Infinity,
                        minDeltaTemp: Infinity,
                        anomalyCount: 0,
                        nodes: []
                    };
                }
                const r = regionMap[county];
                r.nodeCount++;
                r.nodes.push(item.nodeId);
                if (item.cwaTemp !== null && !isNaN(item.cwaTemp)) {
                    r.cwaTempSum += item.cwaTemp;
                    r.cwaTempCount++;
                }
                if (item.nodeTemp !== null && !isNaN(item.nodeTemp)) {
                    r.meshTempSum += item.nodeTemp;
                    r.meshTempCount++;
                }
                if (item.cwaWeather) r.weatherList.push(item.cwaWeather);
                if (item.deltaTemp !== null) {
                    r.validDeltaCount++;
                    r.deltaTempSum += item.deltaTemp;
                    r.maxDeltaTemp = Math.max(r.maxDeltaTemp, item.deltaTemp);
                    r.minDeltaTemp = Math.min(r.minDeltaTemp, item.deltaTemp);
                }
                if (item.deltaHum !== null) r.deltaHumSum += item.deltaHum;
                if (item.anomaly) r.anomalyCount++;
            }

            const regionSummary = Object.values(regionMap).map(r => ({
                county: r.county,
                nodeCount: r.nodeCount,
                avgCwaTemp: r.cwaTempCount > 0 ? Math.round(r.cwaTempSum / r.cwaTempCount * 10) / 10 : null,
                avgMeshTemp: r.meshTempCount > 0 ? Math.round(r.meshTempSum / r.meshTempCount * 10) / 10 : null,
                avgDeltaTemp: r.validDeltaCount > 0 ? Math.round(r.deltaTempSum / r.validDeltaCount * 10) / 10 : null,
                maxDeltaTemp: r.maxDeltaTemp === -Infinity ? null : r.maxDeltaTemp,
                minDeltaTemp: r.minDeltaTemp === Infinity ? null : r.minDeltaTemp,
                avgDeltaHum: r.validDeltaCount > 0 ? Math.round(r.deltaHumSum / r.validDeltaCount) : null,
                weather: r.weatherList.length > 0 ? r.weatherList[0] : '晴',
                anomalyCount: r.anomalyCount,
                anomalyRate: r.nodeCount > 0 ? Math.round(r.anomalyCount / r.nodeCount * 100) : 0
            })).sort((a, b) => b.nodeCount - a.nodeCount);

            res.json({
                nodeComparisons,
                regionSummary,
                totalNodes: nodeComparisons.length,
                cwaStationCount: cwaStations.length,
                cwaReady: true,
                generatedAt: new Date().toISOString()
            });
        });
    });
});

// ==========================================
// ⛅ API 2.3.9: 各縣市分區環境與氣候遙測歷史趨勢
// ==========================================
app.get('/api/analytics/county-weather-trends', withCache(60 * 1000), (req, res) => {
    db.all("SELECT station_id, county, latitude, longitude FROM cwa_weather_stations WHERE latitude IS NOT NULL AND longitude IS NOT NULL", [], (err, cwaStations) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all("SELECT node_id, latitude, longitude FROM nodes WHERE latitude IS NOT NULL AND latitude != 0 AND longitude IS NOT NULL AND longitude != 0", [], (nErr, nodes) => {
            if (nErr) return res.status(500).json({ error: nErr.message });

            const nodeCountyMap = {};
            for (const n of (nodes || [])) {
                let nearestCounty = '全網/其它';
                let minDist = Infinity;
                for (const st of (cwaStations || [])) {
                    const dist = calculateHaversineDistance(n.latitude, n.longitude, st.latitude, st.longitude);
                    if (dist < minDist) {
                        minDist = dist;
                        nearestCounty = st.county;
                    }
                }
                nodeCountyMap[n.node_id] = nearestCounty;
            }

            const sqlTele = `
                SELECT 
                    node_id,
                    strftime('%Y-%m-%d', timestamp) as date,
                    temperature,
                    humidity
                FROM telemetry_data
                WHERE (temperature IS NOT NULL OR humidity IS NOT NULL)
                  AND timestamp >= datetime('now', '-30 days')
                ORDER BY date ASC
            `;

            db.all(sqlTele, [], (tErr, teleRows) => {
                if (tErr) return res.status(500).json({ error: tErr.message });

                const dateCountyMap = {};
                const allCountiesSet = new Set();

                (teleRows || []).forEach(r => {
                    const date = r.date;
                    const county = nodeCountyMap[r.node_id] || '全網/其它';
                    allCountiesSet.add(county);

                    if (!dateCountyMap[date]) dateCountyMap[date] = {};
                    if (!dateCountyMap[date][county]) {
                        dateCountyMap[date][county] = { tempSum: 0, tempCount: 0, humSum: 0, humCount: 0 };
                    }
                    if (!dateCountyMap[date]['全網平均']) {
                        dateCountyMap[date]['全網平均'] = { tempSum: 0, tempCount: 0, humSum: 0, humCount: 0 };
                    }

                    const cObj = dateCountyMap[date][county];
                    const allObj = dateCountyMap[date]['全網平均'];

                    if (r.temperature !== null && r.temperature !== undefined) {
                        cObj.tempSum += r.temperature;
                        cObj.tempCount++;
                        allObj.tempSum += r.temperature;
                        allObj.tempCount++;
                    }
                    if (r.humidity !== null && r.humidity !== undefined) {
                        cObj.humSum += r.humidity;
                        cObj.humCount++;
                        allObj.humSum += r.humidity;
                        allObj.humCount++;
                    }
                });

                const sortedCounties = Array.from(allCountiesSet).sort();
                const counties = ['全網平均', ...sortedCounties];
                const datesList = Object.keys(dateCountyMap).sort();

                const tempTrends = datesList.map(d => {
                    const row = { date: d };
                    for (const c of counties) {
                        const data = dateCountyMap[d][c];
                        row[c] = (data && data.tempCount > 0) ? Math.round((data.tempSum / data.tempCount) * 10) / 10 : null;
                    }
                    return row;
                });

                const humTrends = datesList.map(d => {
                    const row = { date: d };
                    for (const c of counties) {
                        const data = dateCountyMap[d][c];
                        row[c] = (data && data.humCount > 0) ? Math.round(data.humSum / data.humCount) : null;
                    }
                    return row;
                });

                res.json({
                    counties,
                    tempTrends,
                    humTrends
                });
            });
        });
    });
});
// ==========================================
// 🚀 API Bundle: 一鍵打包全網宏觀戰情中心所有數據 (極速快取 10分鐘 + 背景預熱)
// ==========================================
const bundleCacheMap = {};

app.get('/api/analytics/bundle', async (req, res) => {
    const range = req.query.range || '7d';
    const now = Date.now();

    // 🚀 快取延長至 10 分鐘，結合背景 setInterval 自動更新，用戶點擊 NOC 達成 0ms 載入
    if (bundleCacheMap[range] && (now - bundleCacheMap[range].timestamp < 10 * 60 * 1000)) {
        return res.json(bundleCacheMap[range].data);
    }

    const currentPort = server.address()?.port || PORT;
    const baseUrl = `http://127.0.0.1:${currentPort}`;

    try {
        const endpoints = [
            `/api/analytics/kpi?range=${range}`,
            `/api/analytics/trends?range=${range}`,
            '/api/analytics/roles',
            `/api/analytics/traffic?range=${range}`,
            `/api/analytics/signal-health?range=${range}`,
            `/api/analytics/hop-distribution?range=${range}`,
            '/api/analytics/hop-distribution',
            `/api/analytics/hourly-activity?range=${range}`,
            '/api/analytics/hourly-peak-stacked',
            '/api/analytics/cu-distribution',
            '/api/analytics/hardware-models',
            '/api/analytics/firmware-versions',
            `/api/analytics/environment-trends?range=${range}`,
            '/api/analytics/cwa-comparison',
            '/api/analytics/cwa-node-comparison',
            '/api/analytics/air-util-distribution',
            `/api/analytics/top-gateways?range=${range}`,
            '/api/analytics/duplicate-stats',
            '/api/analytics/power-health',
            '/api/analytics/mesh-interconnectivity',
            '/api/analytics/weak-signal-alerts',
            '/api/analytics/solar-charging-health',
            '/api/analytics/county-weather-trends'
        ];

        const results = [];
        for (const ep of endpoints) {
            try {
                const r = await fetch(`${baseUrl}${ep}`);
                results.push(r.ok ? await r.json() : null);
            } catch (e) {
                results.push(null);
            }
        }

        const payload = {
            kpi: results[0],
            trends: results[1],
            roles: results[2],
            traffic: results[3],
            signalHealth: results[4],
            hopDist: results[5],
            hopAnalysis: results[6],
            hourlyActivity: results[7],
            hourlyStacked: results[8],
            cuDist: results[9],
            hwModels: results[10],
            firmwareVersions: results[11],
            envTrends: results[12],
            cwaComparison: results[13],
            cwaNodeComparison: results[14],
            airUtilDist: results[15],
            topGateways: results[16],
            duplicateStats: results[17],
            powerHealth: results[18],
            meshInterconnectivity: results[19],
            weakSignalAlerts: results[20],
            solarChargingHealth: results[21],
            countyWeatherTrends: results[22]
        };

        bundleCacheMap[range] = { data: payload, timestamp: now };
        res.json(payload);
    } catch (err) {
        if (bundleCacheMap[range]) return res.json(bundleCacheMap[range].data);
        res.status(500).json({ error: err.message });
    }
});

// 啟動 Express 伺服器
server.listen(PORT, () => {
    console.log(`🚀 API 伺服器已啟動: http://localhost:${PORT}`);
    console.log(`📊 嘗試存取資料: http://localhost:${PORT}/api/telemetry`);
    bootstrapAnalyticsSummary();
    fetchAndSaveCWAData();
    // 啟動 RF 監聽
    setupRFListener(io, db);

    // ⚡ 背景自動預熱與定時刷新 NOC 全網戰情 Bundle 快取
    const warmCache = () => {
        const portToUse = server.address()?.port || PORT;
        ['7d', '24h', '30d'].forEach(r => {
            fetch(`http://127.0.0.1:${portToUse}/api/analytics/bundle?range=${r}`).catch(() => { });
        });
    };
    setTimeout(warmCache, 2000);
    setInterval(warmCache, 3 * 60 * 1000);
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

let ServiceEnvelope, Telemetry, User, Position, MapReport, Data, Routing, RouteDiscovery, NeighborInfo, MeshPacket;

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
    MeshPacket = root.lookupType("meshtastic.MeshPacket"); // 🚀 Load MeshPacket type
    console.log('📚 Protobuf 字典載入完成！準備啟動雷達...');
    startMqttClient(); // 修正為 startMqttClient
});

// ==========================================
// 3. 啟動 MQTT 監聽與資料寫入
// ==========================================
function startMqttClient() {
    const broker = process.env.MQTT_BROKER;
    const username = process.env.MQTT_USER;
    const password = process.env.MQTT_PASSWORD;

    if (!broker || !username || !password) {
        throw new Error('❌ Missing required MQTT environment variables (MQTT_BROKER, MQTT_USER, MQTT_PASSWORD)');
    }

    const client = mqtt.connect(broker, {
        username: username,
        password: password,
        clientId: 'mesh_dash_' + Math.random().toString(16).substring(2, 10),
        connectTimeout: 5000
    });
    mqttClient = client; // 🚀 Expose client instance

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

            // ⚡ 戰情中心即時流式增量累加
            recordLivePacketAnalytics(port, packet.rx_snr, packet.rx_rssi);

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
                    const fwVer = report.firmware_version || report.firmwareVersion || null;
                    const hwModel = report.hw_model || report.hwModel || null;
                    const role = report.role || null;
                    queueDbOp(`
                        UPDATE nodes SET 
                            long_name = COALESCE(?, nodes.long_name), 
                            short_name = COALESCE(?, nodes.short_name), 
                            latitude = ?, 
                            longitude = ?,
                            hw_model = COALESCE(?, nodes.hw_model),
                            role = COALESCE(?, nodes.role),
                            firmware_version = COALESCE(?, nodes.firmware_version)
                        WHERE node_id = ?
                    `, [report.long_name, report.short_name, lat, lng, hwModel, role, fwVer, fromId], function (err) {
                        if (!err) {
                            console.log(`🗺️ [地圖報告] 節點: ${report.short_name} -> ${lat}, ${lng} FW: ${fwVer || '--'}`);
                            batchEmit('node_seen', {
                                node_id: fromId,
                                long_name: report.long_name,
                                short_name: report.short_name,
                                latitude: lat,
                                longitude: lng,
                                hw_model: hwModel,
                                role: role,
                                firmware_version: fwVer,
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

                    recordLivePacketAnalytics(port, packet.rx_snr, packet.rx_rssi, env.temperature, env.relative_humidity);

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
cron.schedule('0 0 * * 0', () => {
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

        // 🧹 清理 30 天以前的舊備份
        try {
            const files = fs.readdirSync(googleDrivePath);
            const now = new Date();
            const maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 天的毫秒數

            files.forEach(file => {
                const match = file.match(/^meshtastic_backup_(\d{4}-\d{2}-\d{2})\.db$/);
                if (match) {
                    const fileDateStr = match[1];
                    const fileDate = new Date(fileDateStr);
                    if (!isNaN(fileDate.getTime())) {
                        const ageMs = now - fileDate;
                        if (ageMs > maxAgeMs) {
                            const oldFilePath = path.join(googleDrivePath, file);
                            fs.unlinkSync(oldFilePath);
                            console.log(`🧹 [備份清理] 已刪除 30 天前舊備份: ${file}`);
                        }
                    }
                }
            });
        } catch (cleanErr) {
            console.error('❌ [備份清理失敗] 發生錯誤:', cleanErr);
        }

    } catch (err) {
        console.error('\n❌ [雲端備份失敗] 發生錯誤:', err);
    }
});

// ==========================================
// 🔌 系統關閉訊號監聽
// ==========================================
let isShuttingDown = false;
function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nReceived ${signal}. Logging shutdown and exiting...`);
    try {
        logSystemEvent('SYSTEM_SHUTDOWN', {
            signal: signal,
            reason: '服務正常終止或系統重啟關機'
        });
    } catch (err) {
        console.error('Failed to log shutdown event:', err);
    }
    setTimeout(() => {
        process.exit(0);
    }, 500);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('message', (msg) => {
    if (msg === 'shutdown') {
        handleShutdown('PM2_SHUTDOWN');
    }
});