import React, { useEffect, useState, useMemo, useRef } from 'react';
import { io } from 'socket.io-client';
import { Activity, Star, Radio, Search, Clock, Zap, Map as MapIcon, List, BarChart3, Info, Database, Signal, HardDrive, Smartphone, Battery, ZapOff, PieChart, X, Sun, Moon, Terminal, Eye, Cpu, RefreshCw, MessageCircle, MapPin } from 'lucide-react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup } from 'react-leaflet';
import NodeMap from './NodeMap'; // 兩者都在 src 下，保持不變
import TelemetryCharts from './TelemetryCharts';
import PacketTypePieChart from './PacketTypePieChart';

export interface Node {
  node_id: string;
  long_name: string;
  short_name: string;
  last_seen: string;
  is_favorite: number;
  role?: string;
  channel?: string;
  hw_model?: string;
  latitude?: number;
  longitude?: number;
  last_topic?: string;
  battery_level?: number;
  voltage?: number;
  current?: number;
  snr?: number;
  rssi?: number;
  air_util_tx?: number;
  channel_utilization?: number;
  temperature?: number;
  humidity?: number;
}

interface Packet {
  from: string;
  portnum: string;
  topic: string;
  time: string;
  timestamp?: string; // 新增：原始時間戳記
  snr?: number;
  rssi?: number;
  gateway_id?: string;
  rawData?: string;
  payload_json?: any;
}

interface GatewayStat {
  gateway_id: string;
  count: number;
  last_seen: string;
  hop_start?: number;
  hop_limit?: number;
}

interface PacketStat {
  portnum: string;
  count: number;
  last_seen: string;
}

// PortNum 種類名稱映射表 (參考 portnums.proto)
const PORTNUM_NAMES: Record<string | number, string> = {
  0: 'UNKNOWN', '0': 'UNKNOWN',
  1: 'TEXT_MESSAGE', '1': 'TEXT_MESSAGE', 'TEXT_MESSAGE_APP': 'TEXT_MESSAGE',
  3: 'POSITION', '3': 'POSITION', 'POSITION_APP': 'POSITION',
  4: 'NODEINFO', '4': 'NODEINFO', 'NODEINFO_APP': 'NODEINFO',
  5: 'ROUTING', '5': 'ROUTING', 'ROUTING_APP': 'ROUTING',
  6: 'ADMIN', '6': 'ADMIN', 'ADMIN_APP': 'ADMIN',
  64: 'STAT_LOG',
  65: 'WAYPOINT',
  67: 'TELEMETRY', '67': 'TELEMETRY', 'TELEMETRY_APP': 'TELEMETRY',
  70: 'TRACEROUTE', '70': 'TRACEROUTE', 'TRACEROUTE_APP': 'TRACEROUTE',
  71: 'NEIGHBORINFO', '71': 'NEIGHBORINFO', 'NEIGHBORINFO_APP': 'NEIGHBORINFO',
  73: 'MAP_REPORT', '73': 'MAP_REPORT', 'MAP_REPORT_APP': 'MAP_REPORT',
};
const socket = io(); // 使用 Vite Proxy

function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'favorites' | 'nodes' | 'chat' | 'details' | 'map' | 'logs'>('favorites');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [mapShowFavoritesOnly, setMapShowFavoritesOnly] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false); // 控制漂浮詳情頁
  const [currentChatChannel, setCurrentChatChannel] = useState('MediumFast'); // 預設 MediumFast
  const [unreadChannels, setUnreadChannels] = useState<Record<string, boolean>>({}); // 紀錄未讀頻道
  const [gatewayStats, setGatewayStats] = useState<GatewayStat[]>([]);
  const [packetStats, setPacketStats] = useState<PacketStat[]>([]);
  const [nodePackets, setNodePackets] = useState<Packet[]>([]);
  const [chatHistory, setChatHistory] = useState<any[]>([]); // 儲存資料庫抓取的歷史訊息
  const [darkMode, setDarkMode] = useState(true); // 預設開啟暗色模式
  const [loadingPackets, setLoadingPackets] = useState(false); // New state for loading indicator
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null); // 控制封包詳情彈窗

  const chatEndRef = useRef<HTMLDivElement>(null); // 用於自動捲動
  const selectedNodeIdRef = useRef<string | null>(null);
  const activeTabRef = useRef(activeTab);
  const currentChatChannelRef = useRef(currentChatChannel);

  // 同步狀態到 Ref，確保 Socket 回呼函數能讀到最新值
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { currentChatChannelRef.current = currentChatChannel; }, [currentChatChannel]);

  // 計算是否有任何頻道未讀 (用於主標籤)
  const hasAnyUnreadChat = useMemo(() => Object.values(unreadChannels).some(v => v), [unreadChannels]);

  // 計算過濾後的列表
  const filteredNodes = useMemo(() => {
    return nodes
      .filter(n => 
        n.node_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (n.long_name && n.long_name.toLowerCase().includes(searchQuery.toLowerCase()))
      );
  }, [nodes, searchQuery]);

  const favoriteNodes = useMemo(() => {
    return nodes.filter(n => n.is_favorite === 1);
  }, [nodes]);

  // 整合歷史訊息與即時收到的文字訊息
  const chatMessages = useMemo(() => {
    const liveMsgs = packets
      .filter(p => (PORTNUM_NAMES[p.portnum] === 'TEXT_MESSAGE' || p.portnum === '1' || p.portnum === 1) && p.payload_json?.text && p.payload_json?.channel_name === currentChatChannel)
      .map(p => ({
        node_id: p.from,
        message: p.payload_json.text,
        timestamp: p.timestamp || new Date().toISOString(),
        isLive: true
      }));

    // 合併並徹底移除重複 (根據 node_id, message, timestamp 三者結合判斷)
    const combined = [...chatHistory, ...liveMsgs];
    return combined
      .filter((msg, index, self) => 
        index === self.findIndex((t) => (
          t.node_id === msg.node_id && t.message === msg.message && t.timestamp === msg.timestamp
        ))
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [packets, chatHistory, currentChatChannel]);

  // 切換頻道時抓取歷史紀錄
  useEffect(() => {
    if (activeTab === 'chat') {
      fetch(`/api/chat-history/${encodeURIComponent(currentChatChannel)}`)
        .then(res => res.json())
        .then(data => setChatHistory(data));
    }
  }, [currentChatChannel, activeTab]);

  // 自動捲動到底部
  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // 當使用者進入特定頻道時，清除未讀標記
  useEffect(() => {
    if (activeTab === 'chat' && unreadChannels[currentChatChannel]) {
      setUnreadChannels(prev => {
        if (!prev[currentChatChannel]) return prev;
        const next = { ...prev };
        next[currentChatChannel] = false;
        return next;
      });
    }
  }, [activeTab, currentChatChannel, unreadChannels]);

  useEffect(() => {
    // 1. 初始抓取節點狀態
    fetch('/api/node-status')
      .then(res => res.json())
      .then(data => setNodes(data));
    
    // Initial fetch for global packets
    fetchPackets();

    // 2. 監聽 MQTT 狀態
    socket.on('mqtt_status', (data) => setMqttConnected(data.connected));

    // 3. 監聽節點更新事件
    socket.on('node_seen', (updatedNode: Partial<Node>) => {
      setNodes(prev => {
        const index = prev.findIndex(n => n.node_id === updatedNode.node_id);
        if (index !== -1) {
          const newNodes = [...prev];
          newNodes[index] = { ...prev[index], ...updatedNode };
          return [...newNodes];
        }
        return [updatedNode as Node, ...prev];
      });
    });

    // 監聽原始封包
    socket.on('raw_packet', (packet) => {
      // 更新時間戳記與 RAW Data 支援
      const now = new Date();
      packet.timestamp = now.toISOString();
      packet.time = now.toLocaleTimeString('zh-TW', { hour12: false });

      if (selectedNodeIdRef.current && packet.from === selectedNodeIdRef.current) {
        setNodePackets(prev => [packet, ...prev].slice(0, 20));
      }

      // 未讀訊息點點邏輯
      const isText = (PORTNUM_NAMES[packet.portnum] === 'TEXT_MESSAGE' || packet.portnum === '1' || packet.portnum === 1);
      if (isText && packet.payload_json?.text && packet.payload_json?.channel_name) {
        const msgChan = packet.payload_json.channel_name;
        // 如果使用者目前不在對話頁面，或者不在該頻道，則點亮紅點
        if (activeTabRef.current !== 'chat' || currentChatChannelRef.current !== msgChan) {
          setUnreadChannels(prev => ({ ...prev, [msgChan]: true }));
        }
      }
    });

    // 4. 監聽遙測更新 (更新列表中的數據)
    socket.on('telemetry_update', (data) => {
      setNodes(prev => prev.map(n => n.node_id === data.node_id ? { 
        ...n, 
        battery_level: data.battery_level, 
        voltage: data.voltage,
        current: data.current,
        snr: data.snr,
        rssi: data.rssi,
        air_util_tx: data.air_util_tx,
        channel_utilization: data.channel_utilization,
        temperature: data.temperature,
        humidity: data.humidity
      } : n));
    });

    return () => {
      socket.off('mqtt_status');
      socket.off('node_seen');
      socket.off('raw_packet');
    };
  }, []);

  // Function to fetch global packets
  const fetchPackets = async () => {
    setLoadingPackets(true);
    try {
      const res = await fetch('/api/packets?limit=50');
      const data = await res.json();
      setPackets(data.map((p: any) => ({
        from: p.node_id,
        portnum: p.portnum,
        topic: p.topic,
        time: (() => {
          const dateStr = p.timestamp.includes(' ') ? p.timestamp.replace(' ', 'T') + 'Z' : p.timestamp;
          return new Date(dateStr).toLocaleTimeString('zh-TW', { hour12: false });
        })(),
        timestamp: p.timestamp,
        snr: p.snr,
        rssi: p.rssi,
        gateway_id: p.gateway_id,
        rawData: p.raw_hex,
        payload_json: p.payload_json ? (typeof p.payload_json === 'string' ? JSON.parse(p.payload_json) : p.payload_json) : null
      })));
    } catch (error) {
      console.error("Failed to fetch packets:", error);
    } finally {
      setLoadingPackets(false);
    }
  };

  // 新增：抓取單一節點的詳細統計與封包紀錄
  const fetchNodeStats = async (nodeId: string) => {
    setLoadingPackets(true);
    try {
      const [gwRes, statRes, pktRes] = await Promise.all([
        fetch(`/api/node/${encodeURIComponent(nodeId)}/gateways`),
        fetch(`/api/node/${encodeURIComponent(nodeId)}/packet-stats`),
        fetch(`/api/node/${encodeURIComponent(nodeId)}/packets?limit=20`)
      ]);

      setGatewayStats(await gwRes.json());
      setPacketStats(await statRes.json());
      const pktData = await pktRes.json();
      setNodePackets(pktData.map((p: any) => ({
        from: p.node_id,
        portnum: p.portnum,
        topic: p.topic,
        time: (() => {
          const dateStr = p.timestamp.includes(' ') ? p.timestamp.replace(' ', 'T') + 'Z' : p.timestamp;
          return new Date(dateStr).toLocaleTimeString('zh-TW', { hour12: false });
        })(),
        timestamp: p.timestamp,
        snr: p.snr,
        rssi: p.rssi,
        gateway_id: p.gateway_id,
        rawData: p.raw_hex,
        payload_json: p.payload_json ? (typeof p.payload_json === 'string' ? JSON.parse(p.payload_json) : p.payload_json) : null
      })));
    } catch (error) {
      console.error("Failed to fetch node stats:", error);
    } finally {
      setLoadingPackets(false);
    }
  };

  // 當選擇變動時同步更新 selectedNode 物件
  useEffect(() => {
    const node = nodes.find(n => n.node_id === selectedNodeId);
    selectedNodeIdRef.current = selectedNodeId;
    if (node) setSelectedNode(node);
    if (selectedNodeId) fetchNodeStats(selectedNodeId);
  }, [selectedNodeId, nodes]);

  // 切換最愛狀態
  const toggleFavorite = async (nodeId: string, currentStatus: number) => {
    const newStatus = currentStatus === 1 ? 0 : 1;
    try {
      const res = await fetch(`/api/node/${encodeURIComponent(nodeId)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_favorite: newStatus })
      });
      if (res.ok) {
        setNodes(prev => prev.map(n => n.node_id === nodeId ? { ...n, is_favorite: newStatus } : n));
      }
    } catch (err) {
      console.error("Failed to toggle favorite", err);
    }
  };

  // 開啟漂浮詳情頁的處理
  const handleShowModal = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setIsDetailModalOpen(true);
  };

  // 渲染封包詳情中的專屬視覺化元件
  const renderPacketVisualizer = (packet: Packet) => {
    const type = PORTNUM_NAMES[packet.portnum] || packet.portnum;
    const data = packet.payload_json;
    if (!data) return null;

    switch (type) {
      case 'TELEMETRY': {
        const metrics: any = { 
          ...(data.device_metrics || data.deviceMetrics || {}),
          ...(data.environment_metrics || data.environmentMetrics || {}),
          ...(data.power_metrics || data.powerMetrics || {})
        };
        return (
          <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
            <h5 className="text-[10px] font-black uppercase text-slate-500 mb-3 tracking-widest flex items-center gap-2">
              <Activity size={14} className="text-blue-500" /> 遙測數據指標 Telemetry Metrics
            </h5>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              {Object.entries(metrics).map(([key, val]: [string, any]) => (
                <div key={key} className="flex justify-between border-b border-slate-100 dark:border-slate-800 pb-1">
                  <span className="text-slate-400 font-medium uppercase tracking-tighter text-[9px]">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}</span>
                  <span className={`font-mono font-bold ${darkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                    {typeof val === 'number' ? (val % 1 === 0 ? val : val.toFixed(2)) : String(val)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      }
      case 'POSITION': {
        const lat = data.latitude_i ? data.latitude_i / 1e7 : data.latitude;
        const lon = data.longitude_i ? data.longitude_i / 1e7 : data.longitude;
        if (!lat || !lon) return null;
        return (
          <div className="space-y-2">
            <h5 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
              <MapPin size={14} className="text-green-500" /> 位置廣播 Position Broadcast
            </h5>
            <div className="h-48 rounded-xl overflow-hidden border border-slate-300">
               <MapContainer center={[lat, lon]} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                 <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                 <CircleMarker center={[lat, lon]} radius={8} pathOptions={{ fillColor: '#22c55e', color: 'white', weight: 2, fillOpacity: 0.9 }} />
               </MapContainer>
            </div>
          </div>
        );
      }
      case 'NODEINFO': {
        const fields = [
          { label: 'Long Name', val: data.long_name || data.longName },
          { label: 'Short Name', val: data.short_name || data.shortName },
          { label: 'Role', val: data.role, color: 'text-cyan-500' },
          { label: 'Hardware', val: data.hw_model || data.hwModel },
          { label: 'ID', val: data.id }
        ];
        return (
          <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
             <h5 className="text-[10px] font-black uppercase text-slate-500 mb-3 tracking-widest flex items-center gap-2">
               <Smartphone size={14} className="text-cyan-500" /> 節點身份資訊 Node Identity
             </h5>
             <div className="grid grid-cols-2 gap-4 text-xs">
               {fields.map(f => f.val && (
                 <div key={f.label} className="flex flex-col border-b border-slate-100 dark:border-slate-800 pb-1">
                   <span className="text-slate-400 text-[9px] uppercase font-bold">{f.label}</span>
                   <span className={`font-bold truncate ${f.color || ''}`}>{f.val}</span>
                 </div>
               ))}
             </div>
          </div>
        );
      }
      case 'TEXT_MESSAGE': {
        return (
          <div className="space-y-2">
             <h5 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
               <MessageCircle size={14} className="text-purple-500" /> 訊息內容 Message Content
             </h5>
             <div className="flex justify-start">
               <div className={`px-4 py-2 rounded-2xl rounded-tl-none text-sm shadow-sm ${darkMode ? 'bg-slate-800 text-slate-100 border border-slate-700' : 'bg-white text-slate-800 border border-slate-200'}`}>
                 {data.text}
               </div>
             </div>
          </div>
        );
      }
      case 'TRACEROUTE': {
        const routeRaw = data.route || [];
        const route = routeRaw.map((id: number | string) => 
          typeof id === 'number' ? `!${id.toString(16).padStart(8, '0')}` : id
        );
        const sourceNode = nodes.find(n => n.node_id === packet.from);
        const destId = route[route.length - 1];
        const destNode = nodes.find(n => n.node_id === destId);
        
        const points: [number, number][] = [];
        if (sourceNode?.latitude && sourceNode?.longitude) points.push([sourceNode.latitude, sourceNode.longitude]);
        if (destNode?.latitude && destNode?.longitude) points.push([destNode.latitude, destNode.longitude]);

        return (
          <div className="space-y-2">
             <h5 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
               <Zap size={14} className="text-yellow-500" /> 路徑追蹤 Traceroute Path
             </h5>
             {points.length === 2 ? (
               <div className="h-48 rounded-xl overflow-hidden border border-slate-300">
                 <MapContainer bounds={points} style={{ height: '100%', width: '100%' }} zoomControl={false} boundsOptions={{ padding: [20, 20] }}>
                   <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                   <CircleMarker center={points[0]} radius={6} pathOptions={{ fillColor: '#eab308', color: 'white', weight: 2, fillOpacity: 1 }} />
                   <CircleMarker center={points[1]} radius={6} pathOptions={{ fillColor: '#ef4444', color: 'white', weight: 2, fillOpacity: 1 }} />
                   <Polyline positions={points} color="#eab308" weight={2} dashArray="5, 5" />
                 </MapContainer>
               </div>
             ) : (
               <div className={`p-4 rounded-xl text-center text-[10px] italic ${darkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'}`}>
                 無法顯示地圖：來源或目的地節點缺少 GPS 座標
               </div>
             )}
             <div className="flex flex-wrap gap-1 mt-2">
               {route.map((id: string, i: number) => (
                 <div key={i} className="flex items-center gap-1">
                   <span className="px-1.5 py-0.5 bg-slate-200 dark:bg-slate-800 rounded text-[9px] font-mono text-slate-500">
                     {id}
                   </span>
                   {i < route.length - 1 && <span className="text-slate-400">→</span>}
                 </div>
               ))}
             </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className={`min-h-screen transition-colors duration-300 ${darkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans`}>
      {/* Top Navbar */}
      <nav className={`${darkMode ? 'bg-slate-900' : 'bg-[#1e293b]'} text-white px-6 py-3 flex justify-between items-center shadow-lg border-b ${darkMode ? 'border-slate-800' : 'border-slate-700'}`}>
        <div className="flex items-center gap-3">
          <Radio className={mqttConnected ? "text-cyan-400 animate-pulse" : "text-slate-500"} size={24} />
          <span className="text-lg font-black tracking-widest uppercase">Meshtastic <span className="text-cyan-400">Radar</span></span>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <button 
            onClick={() => setDarkMode(!darkMode)}
            className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-slate-800 text-yellow-400' : 'hover:bg-slate-700 text-slate-300'}`}
            title={darkMode ? "切換亮色模式" : "切換暗色模式"}
          >
            {darkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <span className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[10px] font-bold ${mqttConnected ? 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10' : 'border-red-500/50 text-red-400 bg-red-500/10'}`}>
            <div className={`w-2 h-2 rounded-full ${mqttConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
            {mqttConnected ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </nav>

      {/* Tabs Menu */}
      <div className={`border-b sticky top-0 z-50 shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="max-w-6xl mx-auto flex">
          <button 
            onClick={() => setActiveTab('favorites')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'favorites' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Star size={16} /> 最愛節點
          </button>
          <button 
            onClick={() => setActiveTab('nodes')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'nodes' ? 'border-cyan-500 text-cyan-500 bg-cyan-500/5' : 'border-transparent text-slate-500 hover:text-cyan-400'}`}
          >
            <List size={18} /> 節點清單
          </button>
          <button 
            onClick={() => setActiveTab('chat')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all relative ${activeTab === 'chat' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <MessageCircle size={16} /> 頻道對話
            {hasAnyUnreadChat && (
              <span className="absolute top-3 right-3 w-2 h-2 bg-red-500 rounded-full border-2 border-white dark:border-slate-900 animate-pulse"></span>
            )}
          </button>
          <button 
            onClick={() => setActiveTab('details')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'details' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Info size={16} /> 節點詳情
          </button>
          <button 
            onClick={() => setActiveTab('map')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'map' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <MapIcon size={16} /> 地圖監控
          </button>
          <button 
            onClick={() => setActiveTab('logs')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'logs' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Database size={16} /> 封包觀察
          </button>
        </div>
      </div>

      <main className="max-w-7xl mx-auto p-6">
        {activeTab === 'nodes' && (
          <div className="space-y-6">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="快速搜尋節點..." 
                className={`w-full pl-10 pr-4 py-2 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 outline-none text-sm transition-colors ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className={`rounded-xl shadow-sm border overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
              <table className="w-full text-left border-collapse">
                <thead className={`${darkMode ? 'bg-slate-800/50 text-slate-400' : 'bg-slate-50 text-slate-500'} border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                  <tr className="text-[10px] font-black uppercase tracking-widest">
                    <th className="px-6 py-4">最愛</th>
                    <th className="px-6 py-4">Node ID</th>
                    <th className="px-6 py-4">角色</th>
                    <th className="px-6 py-4">節點名稱 (Short)</th>
                    <th className="px-6 py-4">硬體型號</th>
                    <th className="px-6 py-4">頻道</th>
                    <th className="px-6 py-4">最後活動</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                  {filteredNodes.map(node => (
                    <tr 
                      key={node.node_id} 
                      onClick={() => { setSelectedNodeId(node.node_id); setActiveTab('details'); }}
                      className={`cursor-pointer transition-colors group text-sm ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}
                    >
                      <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => toggleFavorite(node.node_id, node.is_favorite)} className={node.is_favorite ? 'text-yellow-500' : 'text-slate-300 hover:text-slate-400'}>
                          <Star fill={node.is_favorite ? "currentColor" : "none"} size={18} />
                        </button>
                      </td>
                      <td className="px-6 py-4 font-mono font-bold text-cyan-600">
                        {node.node_id}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          node.role?.includes('ROUTER') ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' :
                          node.role?.includes('BASE') ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                          node.role?.includes('REPEATER') ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' :
                          node.role?.includes('TRACKER') ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' :
                          darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {node.role?.replace('_', ' ') || 'CLIENT'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1.5">
                          <span className={`font-black truncate max-w-[120px] ${darkMode ? 'text-slate-100' : 'text-slate-900'}`}>{node.long_name || 'Unknown'}</span>
                          <span className="text-[10px] font-bold text-cyan-500 bg-cyan-500/10 px-1 rounded">({node.short_name || '??'})</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-mono border uppercase tracking-tighter ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                          {node.hw_model?.replace(/_/g, ' ') || 'UNKNOWN'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className={`text-[10px] max-w-[120px] truncate font-bold ${darkMode ? 'text-cyan-400/80' : 'text-cyan-700'}`} title={node.last_topic}>
                          {(() => {
                            const rawChannel = node.channel || '';
                            // 過濾掉純數字(版本號)與明顯錯誤的系統標籤
                            const isInvalid = /^\d+$/.test(rawChannel) || ['c', 'json', 'e', 'stat', ''].includes(rawChannel);
                            const channelName = isInvalid ? (() => {
                                const parts = (node.last_topic || '').split('/');
                                return parts.find(p => !/^\d+$/.test(p) && !['msh', 'TW', 'c', 'json', 'e', 'stat', ''].includes(p) && !p.startsWith('!')) || '-';
                            })() : rawChannel;
                            return channelName === 'MediumFast' ? '⚡ ' + channelName : channelName;
                          })()}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-xs font-medium text-slate-500 whitespace-nowrap">
                        {new Date(node.last_seen).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div className={`flex flex-col h-[75vh] rounded-2xl border shadow-xl overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            {/* Channel Selector Header */}
            <div className={`px-4 pt-4 border-b ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-white'}`}>
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <MessageCircle className="text-cyan-500" size={20} />
                  <h3 className="font-black uppercase tracking-widest text-sm">Mesh Messager</h3>
                </div>
                <button onClick={fetchPackets} className="p-1.5 hover:bg-slate-200/20 rounded-full transition-colors text-slate-400"><RefreshCw size={14} className={loadingPackets ? 'animate-spin' : ''}/></button>
              </div>
              
              {/* 頻道切換標籤 */}
              <div className="flex gap-2 pb-1 overflow-x-auto no-scrollbar">
                {['MediumFast', 'MeshTW', 'SignalTest', 'Emergency!'].map(chan => (
                  <button
                    key={chan}
                    onClick={() => setCurrentChatChannel(chan)}
                    className={`px-4 py-2 rounded-t-lg text-[10px] font-black uppercase tracking-tighter transition-all whitespace-nowrap border-b-2 relative ${
                      currentChatChannel === chan 
                        ? 'border-cyan-500 text-cyan-500 bg-cyan-500/5' 
                        : 'border-transparent text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {chan === 'Emergency!' ? '🚨 ' + chan : chan}
                    {unreadChannels[chan] && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full shadow-[0_0_5px_rgba(239,68,68,0.8)] animate-pulse"></span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin">
              {chatMessages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 italic">
                  <MessageCircle size={48} className="mb-4 opacity-10" />
                  <p>尚無文字訊息紀錄</p>
                </div>
              )}
              {chatMessages.map((msg, idx) => {
                // 關鍵修正：對話結構中使用 node_id 進行比對，確保能識別「最愛節點」
                const sender = nodes.find(n => n.node_id === msg.node_id);
                const isFavorite = sender?.is_favorite === 1;
                
                return (
                  <div key={idx} className={`flex ${isFavorite ? 'justify-end' : 'justify-start'} w-full animate-in fade-in slide-in-from-bottom-2`}>
                    <div className={`flex gap-3 max-w-[80%] ${isFavorite ? 'flex-row-reverse' : 'flex-row'}`}>
                      {/* Avatar */}
                      <div 
                        onClick={() => handleShowModal(msg.node_id)}
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-[10px] font-black border-2 flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity ${isFavorite ? 'bg-cyan-500 border-cyan-400 text-white' : 'bg-slate-700 border-slate-600 text-slate-300'}`}
                      >
                        {sender?.short_name || '??'}
                      </div>
                      
                      {/* Bubble */}
                      <div className={`flex flex-col ${isFavorite ? 'items-end' : 'items-start'}`}>
                        <div className="flex items-center gap-2 mb-1 px-1">
                          {/* 名稱點擊跳轉 */}
                          <button onClick={() => handleShowModal(msg.node_id)} className={`text-[10px] font-bold hover:underline ${isFavorite ? 'text-yellow-500' : 'text-cyan-500'}`}>
                            {msg.node_id} {sender?.long_name ? `(${sender.long_name})` : ''}
                          </button>
                          <span className="text-[9px] text-slate-500 font-mono">
                            {(() => {
                              // 修正時區：強制視為 UTC 並轉換為台灣本地時間
                              const dateStr = msg.timestamp.includes(' ') ? msg.timestamp.replace(' ', 'T') + 'Z' : msg.timestamp;
                              return new Date(dateStr).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            })()}
                          </span>
                          {isFavorite && <span className="text-[10px] font-bold text-yellow-500">YOU (FAV)</span>}
                        </div>
                        <div className={`px-4 py-2 rounded-2xl text-sm shadow-sm break-all ${
                          isFavorite 
                            ? 'bg-cyan-600 text-white rounded-tr-none' 
                            : darkMode 
                              ? 'bg-slate-800 text-slate-100 border border-slate-700 rounded-tl-none' 
                              : 'bg-white text-slate-800 border border-slate-200 rounded-tl-none'
                        }`}>
                          {msg.message}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <div className={`p-3 text-center text-[9px] font-bold tracking-widest text-slate-500 border-t ${darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
              MESSAGES LOADED FROM MQTT CACHE
            </div>
          </div>
        )}

        {activeTab === 'favorites' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold flex items-center gap-2 text-yellow-600">
              <Star size={24} fill="currentColor" /> 最愛節點 ({favoriteNodes.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {favoriteNodes.map(node => (
                <div 
                  key={node.node_id} 
                  onClick={() => { setSelectedNodeId(node.node_id); setActiveTab('details'); }}
                  className={`p-4 rounded-xl border-2 transition-all cursor-pointer shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800 hover:border-yellow-500/50' : 'bg-white border-yellow-100 hover:border-yellow-400'}`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <span className="px-2 py-1 bg-yellow-500 text-white text-xs font-mono rounded">{node.node_id}</span>
                    <button onClick={(e) => { e.stopPropagation(); toggleFavorite(node.node_id, node.is_favorite); }} className="text-yellow-500">
                      <Star fill="currentColor" size={20} />
                    </button>
                  </div>
                  <div className={`text-lg font-bold truncate ${darkMode ? 'text-slate-100' : 'text-slate-900'}`}>{node.long_name || 'Unknown'}</div>
                  <div className={`text-sm flex items-center gap-1 mt-1 font-mono uppercase tracking-tighter ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {node.short_name || '??'} | <Clock size={12}/> {new Date(node.last_seen).toLocaleTimeString()}
                  </div>
                </div>
              ))}
              {favoriteNodes.length === 0 && (
                <div className="col-span-full py-20 text-center text-slate-400 italic">
                  尚無收藏節點。點擊節點清單中的星星圖示來加入收藏。
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'details' && (
          <div className="space-y-6">
            {selectedNode ? (
              <div className={`rounded-xl shadow-sm border overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                <div className="bg-slate-900 p-6 text-white flex justify-between items-center">
                  <div>
                    <div className="text-3xl font-black tracking-tight flex items-center gap-3">
                      {selectedNode.long_name}
                      <span className="text-blue-400 text-lg">({selectedNode.short_name})</span>
                    </div>
                    <div className="text-slate-400 text-sm font-mono mt-1">ID: {selectedNode.node_id} | Topic: {selectedNode.last_topic}</div>
                  </div>
                  <div className="flex items-center gap-4 text-right">
                    <button 
                      onClick={() => fetchNodeStats(selectedNode!.node_id)} 
                      className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                      title="重新整理數據"
                    >
                      <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                    </button>
                    <div>
                      <div className="text-xs text-slate-500 uppercase font-bold tracking-widest">最後活動</div>
                      <div className="text-blue-400 font-mono text-lg">{new Date(selectedNode.last_seen).toLocaleString()}</div>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-8">
                  {/* 歷史趨勢圖表 (三個曲線圖) */}
                  <section>
                    <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} />
                  </section>

                  {/* 單一節點地圖 */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                      <MapIcon size={14} /> 節點位置
                    </h4>
                    <div className="h-[512px] rounded-xl overflow-hidden border border-slate-200">
                      {selectedNode.latitude || gatewayStats.length > 0 ? (
                        <NodeMap 
                          nodes={[selectedNode]} 
                          allNodes={nodes} 
                          gateways={gatewayStats}
                          isDetailView={true}
                          onSelectNode={() => {}} 
                        />
                      ) : (
                        <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
                          此節點尚未回報 GPS 位置
                        </div>
                      )}
                    </div>
                    </section>

                  {/* 封包種類分布表格與圓餅圖 */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                      <PieChart size={14} className="text-blue-500" /> 封包種類分布
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                        <table className="w-full text-sm text-left">
                          <thead className={`text-xs border-b ${darkMode ? 'text-slate-500 border-slate-700' : 'text-slate-400'}`}>
                            <tr>
                              <th className="pb-2">Portnum</th>
                              <th className="pb-2 text-right">Count</th>
                            </tr>
                          </thead>
                          <tbody>
                            {packetStats.filter(ps => ps.portnum !== 'ENCRYPTED').map((p, i) => (
                              <tr key={i} className={`border-b last:border-0 ${darkMode ? 'border-slate-700/50' : 'border-slate-200'}`}>
                                <td className={`py-2 font-medium ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>{PORTNUM_NAMES[p.portnum] || p.portnum}</td>
                                <td className="py-2 text-right font-bold text-slate-500">{p.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {packetStats.filter(ps => ps.portnum !== 'ENCRYPTED').length === 0 && <div className="text-xs text-slate-300 italic mt-2">無資料</div>}
                      </div>
                      <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                        <PacketTypePieChart packetStats={packetStats.filter(ps => ps.portnum !== 'ENCRYPTED').map(ps => ({
                          ...ps,
                          portnum: PORTNUM_NAMES[ps.portnum] || ps.portnum
                        }))} />
                      </div>
                    </div>
                  </section>

                  {/* 閘道收信統計 (Gateways) */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Signal size={14} className="text-green-500" /> 途經閘道統計 (Gateways Analytics)
                    </h4>
                    <div className={`border rounded-xl shadow-sm max-h-[440px] overflow-y-auto relative scrollbar-thin ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                      <table className="w-full text-left text-xs border-separate border-spacing-0">
                        <thead className={`sticky top-0 z-10 shadow-[0_1px_0_rgba(0,0,0,0.05)] ${darkMode ? 'bg-slate-800' : 'bg-slate-50'}`}>
                          <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                            <th className="px-4 py-3">Gateway ID</th>
                            <th className="px-4 py-3">角色</th>
                            <th className="px-4 py-3">名稱 (Name)</th>
                            <th className="px-4 py-3 text-center">跳數 (Hops)</th>
                            <th className="px-4 py-3 text-right">累積封包</th>
                            <th className="px-4 py-3">最後活動</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                          {gatewayStats.map((g, i) => {
                            const gwNode = nodes.find(n => n.node_id === g.gateway_id);
                            const hops = (g.hop_start || 0) - (g.hop_limit || 0);
                            return (
                              <tr key={i} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}>
                                <td className="px-4 py-3">
                                  <button 
                                    onClick={() => handleShowModal(g.gateway_id)}
                                    className="font-mono font-bold text-blue-600 hover:underline text-left"
                                  >
                                    {g.gateway_id}
                                  </button>
                                </td>
                                <td className="px-4 py-3">
                                  <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-bold uppercase border">
                                    {gwNode?.role || 'CLIENT'}
                                  </span>
                                </td>
                                <td className={`px-4 py-3 font-medium ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                  {gwNode ? `${gwNode.short_name} | ${gwNode.long_name}` : <span className="text-slate-300 italic">尚未識別節點</span>}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span className={`font-bold ${hops <= 0 ? 'text-green-600' : 'text-orange-500'}`}>{hops <= 0 ? '直接接收' : `${hops} 跳`}</span>
                                </td>
                                <td className={`px-4 py-3 text-right font-black ${darkMode ? 'text-slate-300 bg-slate-800/30' : 'text-slate-600 bg-slate-50/50'}`}>{g.count} <span className="text-[9px] font-normal text-slate-400 ml-1 whitespace-nowrap">pkts</span></td>
                                <td className="px-4 py-3 text-slate-400 text-[10px]">{new Date(g.last_seen).toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {gatewayStats.length === 0 && <div className="p-10 text-center text-slate-300 italic text-sm">無路徑紀錄資料</div>}
                    </div>
                  </section>

                  {/* 節點專屬封包日誌 */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                      <Database size={14} /> 節點封包紀錄 (MQTT Trace)
                    </h4>
                    <div className={`border rounded-xl overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                      <table className="w-full text-left text-[11px] font-mono border-collapse">
                        <thead className={`border-b ${darkMode ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-slate-50 text-slate-500'}`}>
                          <tr>
                            <th className="p-3">收到時間</th>
                            <th className="p-3">種類</th>
                            <th className="p-3">Gateway</th>
                            <th className="p-3 text-center">SNR/RSSI</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                          {nodePackets.map((p, i) => {
                            const gwNode = nodes.find(n => n.node_id === p.gateway_id);
                            return (
                            <tr key={i} className={`border-b last:border-0 transition-colors ${darkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-50'}`}>
                              <td className="p-3 text-slate-400">{p.time}</td>
                              <td className="p-3">
                                <div className="flex items-center gap-2">
                                  {p.portnum === 'ENCRYPTED' ? (
                                    <span className={`px-1.5 py-0.5 rounded border font-bold flex items-center gap-1 ${darkMode ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-red-50 border-red-100 text-red-600'}`}>
                                      <ZapOff size={10} /> PRIVATE
                                    </span>
                                  ) : (
                                    <span className={`px-1.5 py-0.5 rounded border font-bold ${darkMode ? 'bg-slate-800 border-slate-700 text-cyan-400' : 'bg-blue-50 border-blue-100 text-blue-600'}`}>
                                      {PORTNUM_NAMES[p.portnum] || p.portnum}
                                    </span>
                                  )}
                                  {PORTNUM_NAMES[p.portnum] === 'TELEMETRY' && p.payload_json && (
                                    <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap">
                                      {(() => {
                                        const m = p.payload_json.device_metrics || p.payload_json.deviceMetrics;
                                        const pwr = p.payload_json.power_metrics || p.payload_json.powerMetrics;
                                        if (!m && !pwr) return '';
                                        const v = pwr?.ch1_voltage ?? pwr?.ch1Voltage ?? m?.voltage;
                                        const c = pwr?.ch1_current ?? pwr?.ch1Current;
                                        return `${m?.battery_level ?? m?.batteryLevel ?? '?'}% ${v?.toFixed(2) || ''}V ${c ? `(${c.toFixed(0)}mA)` : ''} | AU:${(m?.air_util_tx ?? m?.airUtilTx ?? 0).toFixed(1)}% CU:${(m?.channel_utilization ?? m?.channelUtilization ?? 0).toFixed(1)}%`;
                                      })()}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-3">
                                <button 
                                  onClick={() => p.gateway_id && handleShowModal(p.gateway_id)}
                                  className={`font-bold hover:underline ${darkMode ? 'text-slate-400 hover:text-cyan-400' : 'text-slate-600 hover:text-blue-500'}`}
                                >
                                  {p.gateway_id || 'Unknown'} {gwNode ? `(${gwNode.long_name})` : ''}
                                </button>
                              </td>
                              <td className="p-3 text-center text-slate-500">{p.snr ?? '-'}/{p.rssi ?? '-'}</td>
                              <td className="p-3 text-right">
                                <button 
                                  onClick={() => setSelectedPacket(p)}
                                  className="p-1.5 hover:bg-blue-100 text-blue-500 rounded-md transition-colors"
                                >
                                  <Eye size={14} />
                                </button>
                              </td>
                            </tr>
                          )})}
                        </tbody>
                      </table>
                      {nodePackets.length === 0 && <div className="p-10 text-center text-slate-300 italic">暫無通訊紀錄</div>}
                    </div>
                  </section>
                  </div>
                </div>
            ) : (
              <div className={`h-[60vh] flex flex-col items-center justify-center rounded-2xl border-2 border-dashed text-slate-400 ${darkMode ? 'bg-slate-900 border-slate-800 text-slate-600' : 'bg-white border-slate-200'}`}>
                <Info size={48} className="mb-4 opacity-20" />
                <p className="text-lg">請先從節點清單選擇一個節點以查看詳情</p>
                <button 
                  onClick={() => setActiveTab('nodes')}
                  className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  前往節點清單
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'map' && (
          <div className="space-y-4">
            <div className={`flex justify-between items-center p-3 rounded-xl border shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-white border-slate-200'}`}>
              <div className={`flex rounded-lg p-1 ${darkMode ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <button 
                  onClick={() => setMapShowFavoritesOnly(false)}
                  className={`px-6 py-1.5 text-xs font-black uppercase tracking-widest rounded-md transition-all ${!mapShowFavoritesOnly ? 'bg-cyan-500 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  顯示全部
                </button>
                <button 
                  onClick={() => setMapShowFavoritesOnly(true)}
                  className={`px-6 py-1.5 text-xs font-black uppercase tracking-widest rounded-md transition-all ${mapShowFavoritesOnly ? 'bg-cyan-500 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  最愛節點
                </button>
              </div>
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                Map Visualization: {mapShowFavoritesOnly ? favoriteNodes.length : nodes.length} Nodes
              </div>
            </div>
            <div className={`h-[70vh] rounded-2xl overflow-hidden border-4 shadow-inner relative transition-colors ${darkMode ? 'border-slate-800' : 'border-slate-100'}`}>
              <NodeMap 
                nodes={mapShowFavoritesOnly ? favoriteNodes : nodes} 
                onSelectNode={(id) => setSelectedNodeId(id)} 
                onShowDetail={handleShowModal}
              />
            </div>
          </div>
        )}

        {/* 漂浮詳情頁 (Detail Modal) */}
        {isDetailModalOpen && selectedNode && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
            {/* 背景遮罩 */}
            <div 
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" 
              onClick={() => setIsDetailModalOpen(false)}
            ></div>
            
            {/* 彈窗主體 */}
            <div className={`relative rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto flex flex-col border ${darkMode ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'}`}>
              {/* Modal Header */}
              <div className={`sticky top-0 p-6 flex justify-between items-center z-10 border-b ${darkMode ? 'bg-slate-900 text-white border-slate-800' : 'bg-slate-900 text-white'}`}>
                <div>
                  <div className="text-2xl font-black tracking-tight flex items-center gap-3">
                    {selectedNode.long_name}
                    <span className="text-blue-400 text-lg">({selectedNode.short_name})</span>
                  </div>
                  <button 
                    onClick={() => handleShowModal(selectedNode.node_id)}
                    className="text-slate-400 text-sm font-mono mt-1 hover:text-blue-400"
                  >
                    ID: {selectedNode.node_id}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => fetchNodeStats(selectedNode.node_id)} 
                    className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                    title="重新整理數據"
                  >
                    <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                  </button>
                  <button 
                    onClick={() => setIsDetailModalOpen(false)}
                    className="p-2 hover:bg-slate-800 rounded-full transition-colors"
                  >
                    <X size={24} />
                  </button>
                </div>
              </div>

              {/* Modal Body (複用原本詳情頁的內容) */}
              <div className="p-6 space-y-8">
                <section>
                  <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} />
                </section>

                {/* 封包種類分布 */}
                <section>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                    <PieChart size={14} className="text-blue-500" /> 封包種類分布
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-100'}`}>
                      <table className="w-full text-sm text-left">
                        <thead className={`text-xs border-b ${darkMode ? 'text-slate-500 border-slate-700' : 'text-slate-400'}`}>
                          <tr><th className="pb-2">Portnum</th><th className="pb-2 text-right">Count</th></tr>
                        </thead>
                        <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                          {packetStats.filter(ps => ps.portnum !== 'ENCRYPTED').map((p, i) => (
                            <tr key={i} className="border-b border-slate-200 last:border-0">
                              <td className="py-2 text-slate-700 font-bold">
                                {PORTNUM_NAMES[p.portnum] || p.portnum}
                              </td>
                              <td className="py-2 text-right font-bold text-slate-500">{p.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-100'}`}>
                      <PacketTypePieChart packetStats={packetStats.filter(ps => ps.portnum !== 'ENCRYPTED').map(ps => ({
                        ...ps,
                        portnum: PORTNUM_NAMES[ps.portnum] || ps.portnum
                      }))} />
                    </div>
                  </div>
                </section>

                {/* 閘道統計 */}
                <section>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Signal size={14} className="text-green-500" /> 途經閘道統計
                  </h4>
                  <div className={`border rounded-xl max-h-[300px] overflow-y-auto relative shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <table className="w-full text-left text-xs border-separate border-spacing-0">
                      <thead className={`sticky top-0 z-10 shadow-[0_1px_0_rgba(0,0,0,0.05)] ${darkMode ? 'bg-slate-800' : 'bg-slate-50'}`}>
                        <tr className="text-[10px] font-black uppercase text-slate-400">
                          <th className="px-4 py-3">Gateway ID</th><th className="px-4 py-3">角色</th><th className="px-4 py-3 text-center">跳數</th><th className="px-4 py-3 text-right">累積封包</th>
                        </tr>
                      </thead>
                      <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                        {gatewayStats.map((g, i) => {
                          const gwNode = nodes.find(n => n.node_id === g.gateway_id);
                          return (
                          <tr key={i} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}>
                            <td className="px-4 py-3">
                              <button onClick={() => handleShowModal(g.gateway_id)} className="font-mono text-blue-600 hover:underline">
                                {g.gateway_id} {gwNode ? `(${gwNode.long_name})` : ''}
                              </button>
                            </td>
                            <td className="px-4 py-3">
                              <span className="px-1.5 py-0.5 bg-slate-50 text-slate-400 rounded text-[9px] font-bold uppercase border">
                                {gwNode?.role || 'CLIENT'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">{(g.hop_start || 0) - (g.hop_limit || 0)} 跳</td>
                            <td className="px-4 py-3 text-right font-bold text-slate-500">{g.count}</td>
                          </tr>
                        )})}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* 封包紀錄 */}
                <section>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                    <Database size={14} /> 節點封包紀錄 (MQTT Trace)
                  </h4>
                  <div className={`border rounded-xl overflow-hidden mb-10 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <table className="w-full text-left text-[11px] font-mono">
                      <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                        {nodePackets.map((p, i) => {
                          const senderNode = nodes.find(n => n.node_id === p.from);
                          return (
                          <tr key={i} className="border-b last:border-0 hover:bg-slate-50">
                            <td className="p-2 text-slate-400">{p.time}</td>
                            <td className="p-2">
                              <button onClick={() => handleShowModal(p.from)} className="text-blue-600 font-bold hover:underline">
                                {p.from} {senderNode ? `(${senderNode.short_name})` : ''}
                              </button>
                            </td>
                            <td className="p-2 text-slate-700 font-bold">
                              {p.portnum === 'ENCRYPTED' ? (
                                <span className="text-red-500 font-bold flex items-center gap-1"><ZapOff size={12}/> 私有加密封包</span>
                              ) : (
                                <span className={darkMode ? 'text-slate-300' : 'text-slate-700'}>{PORTNUM_NAMES[p.portnum] || p.portnum}</span>
                              )}
                              {PORTNUM_NAMES[p.portnum] === 'TELEMETRY' && p.payload_json && (
                                <span className="ml-2 text-[10px] text-slate-400 font-normal">
                                  {(() => {
                                    const m = p.payload_json.device_metrics || p.payload_json.deviceMetrics;
                                    if (!m) return '';
                                    return `${m.battery_level ?? m.batteryLevel ?? '?'}% ${m.voltage?.toFixed(2) || ''}V | AU:${(m.air_util_tx ?? m.airUtilTx ?? 0).toFixed(1)}% CU:${(m.channel_utilization ?? m.channelUtilization ?? 0).toFixed(1)}%`;
                                  })()}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-slate-500 truncate max-w-[200px]">{p.topic}</td>
                            <td className="p-2 text-right">
                              <button onClick={() => setSelectedPacket(p)} className="text-blue-500 hover:underline text-[10px] font-bold">查看內容</button>
                            </td>
                          </tr>
                        )})}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}

        {/* 封包細節解析懸浮頁 (Packet JSON Detail Modal) */}
        {selectedPacket && (
          <div className="fixed inset-0 z-[3000] flex items-center justify-center p-6">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setSelectedPacket(null)}></div>
            <div className={`relative w-full max-w-2xl rounded-2xl shadow-2xl border overflow-hidden flex flex-col max-h-[80vh] ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="p-4 bg-blue-600 text-white flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Cpu size={18} />
                  <span className="font-black uppercase tracking-widest text-xs">Packet Payload Decoder</span>
                </div>
                <button onClick={() => setSelectedPacket(null)} className="hover:rotate-90 transition-transform"><X size={20}/></button>
              </div>
              
              <div className="p-6 overflow-y-auto space-y-4">
                <div className="grid grid-cols-2 gap-4 text-[11px]">
                  <div className={`p-3 rounded-lg ${darkMode ? 'bg-slate-800' : 'bg-slate-50'}`}>
                    <span className="text-slate-500 block mb-1 uppercase font-bold">App Port</span>
                    <span className="text-blue-500 font-black">{PORTNUM_NAMES[selectedPacket.portnum] || selectedPacket.portnum}</span>
                  </div>
                  <div className={`p-3 rounded-lg ${darkMode ? 'bg-slate-800' : 'bg-slate-50'}`}>
                    <span className="text-slate-500 block mb-1 uppercase font-bold">Receive Time</span>
                    <span className={darkMode ? 'text-slate-200' : 'text-slate-700'}>{selectedPacket.time}</span>
                  </div>
                </div>

                {renderPacketVisualizer(selectedPacket)}

                <div>
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">Decoded JSON Data</span>
                  <div className={`p-4 rounded-xl font-mono text-xs overflow-x-auto ${darkMode ? 'bg-black text-emerald-400' : 'bg-slate-900 text-slate-200'}`}>
                    {selectedPacket.payload_json ? (
                      <pre>{JSON.stringify(selectedPacket.payload_json, null, 2)}</pre>
                    ) : (
                      <div className="py-4 text-center text-slate-600 italic">
                        此封包為加密內容或無可解析負載 (Encrypted/No Payload)
                      </div>
                    )}
                  </div>
                </div>

                {selectedPacket.rawData && (
                  <div>
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">Raw Payload (Hex / 原始數據)</span>
                    <div className="p-3 bg-slate-100 rounded-lg font-mono text-[9px] text-slate-500 break-all border border-slate-200">
                      {selectedPacket.rawData}
                    </div>
                  </div>
                )}
              </div>

              <div className={`p-4 border-t text-[10px] text-center font-bold tracking-widest ${darkMode ? 'border-slate-800 text-slate-600' : 'border-slate-100 text-slate-400'}`}>
                NODE_ID: {selectedPacket.from} | GW: {selectedPacket.gateway_id}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="space-y-6">
            <div className={`rounded-xl shadow-sm border overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
              <div className={`p-4 border-b flex justify-between items-center ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                <h3 className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
                  <Database size={16} className="text-cyan-500" /> 全域封包觀察 (Global Packet Tracking)
                </h3>
                <button
                  onClick={fetchPackets}
                  disabled={loadingPackets}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase flex items-center gap-1 transition-colors ${
                    loadingPackets ? 'bg-slate-600 text-slate-400 cursor-not-allowed' : 'bg-cyan-600 text-white hover:bg-cyan-700'
                  }`}
                >
                  {loadingPackets ? (
                    <>
                      <RefreshCw size={12} className="animate-spin" /> 載入中...
                    </>
                  ) : (
                    <>
                      <RefreshCw size={12} /> 重新整理
                    </>
                  )}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] font-mono border-collapse">
                  <thead className={`${darkMode ? 'bg-slate-800/30 text-slate-400' : 'bg-slate-100 text-slate-500'} border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                    <tr>
                      <th className="p-3">收到時間</th>
                      <th className="p-3">發送者 (Sender)</th>
                      <th className="p-3">種類 (Port)</th>
                      <th className="p-3">Gateway</th>
                      <th className="p-3 text-center">SNR/RSSI</th>
                      <th className="p-3 text-right">詳情</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                    {packets.map((p, i) => {
                      const senderNode = nodes.find(n => n.node_id === p.from);
                      const gwNode = nodes.find(n => n.node_id === p.gateway_id);
                      return (
                        <tr key={i} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}>
                          <td className="p-3 text-slate-400">{p.time}</td>
                          <td className="p-3">
                            <button 
                              onClick={() => handleShowModal(p.from)}
                              className="text-cyan-600 font-bold hover:underline text-left"
                            >
                              {p.from} {senderNode ? `(${senderNode.short_name})` : ''}
                            </button>
                          </td>
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              {p.portnum === 'ENCRYPTED' ? (
                                <span className={`px-1.5 py-0.5 rounded border font-bold flex items-center gap-1 ${darkMode ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-red-50 border-red-100 text-red-600'}`}>
                                  <ZapOff size={10} /> ENCRYPTED
                                </span>
                              ) : (
                                <span className={`px-1.5 py-0.5 rounded border font-bold ${darkMode ? 'bg-slate-800 border-slate-700 text-cyan-400' : 'bg-blue-50 border-blue-100 text-blue-600'}`}>
                                  {PORTNUM_NAMES[p.portnum] || p.portnum}
                                </span>
                              )}
                              {PORTNUM_NAMES[p.portnum] === 'TELEMETRY' && p.payload_json && (
                                <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap">
                                  {(() => {
                                    const m = p.payload_json.device_metrics || p.payload_json.deviceMetrics;
                                    if (!m) return '';
                                    return `${m.battery_level ?? m.batteryLevel ?? '?'}% ${m.voltage?.toFixed(2) || ''}V`;
                                  })()}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-3">
                            <button 
                              onClick={() => p.gateway_id && handleShowModal(p.gateway_id)}
                              className={`font-bold hover:underline ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}
                            >
                              {p.gateway_id || 'Unknown'} {gwNode ? `(${gwNode.long_name})` : ''}
                            </button>
                          </td>
                          <td className="p-3 text-center text-slate-500">{p.snr ?? '-'}/{p.rssi ?? '-'}</td>
                          <td className="p-3 text-right">
                            <button 
                              onClick={() => setSelectedPacket(p)}
                              className="p-1.5 hover:bg-blue-100 text-blue-500 rounded-md transition-colors"
                            >
                              <Eye size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {packets.length === 0 && <div className="p-20 text-center text-slate-400 italic">尚未收到任何封包...</div>}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;