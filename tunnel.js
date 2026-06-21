const mqtt = require('mqtt');
const net = require('net');
require('dotenv').config();

/**
 * 📡 Meshtastic 雲端多通道路由總機 (tunnel.js)
 * 作用：HiveMQ 雲端頻道 <-> 本地 TCP 埠 (127.0.0.1)
 */

// 1. 設定中繼站對應清單
const TUNNEL_CONFIGS = [
    { name: 'hualien', port: 4404, label: '花蓮老家中繼站', txTopic: 'mesh_tunnel/hualien/tx', rxTopic: 'mesh_tunnel/hualien/rx' },
    { name: 'taipei', port: 4405, label: '台北主機中繼站', txTopic: 'mesh_tunnel/taipei/tx', rxTopic: 'mesh_tunnel/taoyuan/rx' },
    { name: 'sanzhi',  port: 4406, label: '三芝北海岸中繼站', txTopic: 'mesh_tunnel/sanzhi/tx', rxTopic: 'mesh_tunnel/sanzhi/rx' }
];

// 2. 建立 HiveMQ 雲端連線
const mqttOptions = {
    username: process.env.HIVEMQ_USER,
    password: process.env.HIVEMQ_PASSWORD,
    protocol: 'mqtts', // HiveMQ Cloud 必須使用加密連線
    port: 8883,
    rejectUnauthorized: true,
    keepalive: 60,
    reconnectPeriod: 5000 // 斷線後每 5 秒嘗試重連
};

console.log('🚀 正在啟動雲端總機程式...');
const mqttClient = mqtt.connect(process.env.HIVEMQ_URL, mqttOptions);

// 存放所有中繼站的 TCP 連線對象
const activeConnections = {};

// 3. MQTT 事件監聽
mqttClient.on('connect', () => {
    console.log('✅ 已成功連線至 HiveMQ 雲端伺服器！');
    
    // 訂閱所有中繼站的 TX 頻道 (遠端送回台北的資料)
    TUNNEL_CONFIGS.forEach(config => {
        mqttClient.subscribe(config.txTopic, (err) => {
            if (!err) {
                console.log(`📡 [訂閱成功] ${config.label} -> 頻道: ${config.txTopic}`);
            }
        });
        // 初始化連線容器
        activeConnections[config.name] = new Set();
    });
});

mqttClient.on('message', (topic, payload) => {
    // 找出這筆資料屬於哪個站點
    const config = TUNNEL_CONFIGS.find(c => c.txTopic === topic);
    if (!config) return;

    // 將收到的二進位封包轉發到所有連線到該 Port 的 TCP 客戶端 (即 server.js)
    const clients = activeConnections[config.name];
    if (clients && clients.size > 0) {
        console.log(`📦 [雲端 -> 本地] ${config.label} 收到封包 (${payload.length} bytes)`);
        clients.forEach(socket => {
            try {
                socket.write(payload);
            } catch (e) {
                console.error(`❌ [發送失敗] ${config.label} 的 TCP 客戶端已失效`);
            }
        });
    }
});

mqttClient.on('error', (err) => {
    console.error('❌ [MQTT 錯誤]', err.message);
});

// 4. 建立本地 TCP 伺服器
TUNNEL_CONFIGS.forEach(config => {
    const server = net.createServer((socket) => {
        console.log(`🔌 [TCP 連線] 主程式已接入 ${config.label} (Port: ${config.port})`);
        
        activeConnections[config.name].add(socket);

        // 如果主程式 (server.js) 想發送資料回遠端節點 (TX)
        socket.on('data', (data) => {
            console.log(`📤 [本地 -> 雲端] 從 Port ${config.port} 發送封包到 ${config.label}`);
            mqttClient.publish(config.rxTopic, data);
        });

        socket.on('close', () => {
            console.log(`❌ [TCP 中斷] 主程式已離開 ${config.label}`);
            activeConnections[config.name].delete(socket);
        });

        socket.on('error', (err) => {
            console.error(`⚠️ [TCP 錯誤] ${config.label}:`, err.message);
            activeConnections[config.name].delete(socket);
        });
    });

    server.listen(config.port, '127.0.0.1', () => {
        console.log(`🏢 [本地櫃檯開張] ${config.label} 已就緒於 127.0.0.1:${config.port}`);
    });
});

// 5. 異常捕捉
process.on('uncaughtException', (err) => {
    console.error('💥 tunnel.js 偵測到嚴重錯誤:', err);
});
