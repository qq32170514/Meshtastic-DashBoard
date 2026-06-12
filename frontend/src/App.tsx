import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Activity, Star, Radio, Search, Clock, Zap, Map as MapIcon, List, BarChart3, Info, Database, Signal, HardDrive, Smartphone, Battery, ZapOff, PieChart, X, Sun, Moon, Terminal, Eye, Cpu, RefreshCw, MessageCircle, MapPin, Filter, TrendingDown, Settings } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup } from 'react-leaflet';
import NodeMap from './NodeMap'; 
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
  firmware_version?: string;
  firmware_build_num?: string;
  last_gateway?: string;
  source?: string;       // 🚀 新增來源站點
  sourceLabel?: string;  // 🚀 新增來源標籤
}

interface Packet {
  from: string;
  portnum: string;
  topic: string;
  time: string;
  timestamp?: string; 
  snr?: number;
  rssi?: number;
  gateway_id?: string;
  rawData?: string;
  payload_json?: any;
  source?: string;       // 🚀 新增來源站點
  sourceLabel?: string;  // 🚀 新增來源標籤
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

// PortNum 種類名稱映射表
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
const socket = io();

function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [favoritePackets, setFavoritePackets] = useState<Packet[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'favorites' | 'nodes' | 'details' | 'map' | 'logs' | 'chat' | 'gateways'>('favorites');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mapShowFavoritesOnly, setMapShowFavoritesOnly] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false); 
  const [currentChatChannel, setCurrentChatChannel] = useState('MediumFast'); // 預設改為 MediumFast
  const [unreadChannels, setUnreadChannels] = useState<Record<string, boolean>>({}); 
  const [gatewayStats, setGatewayStats] = useState<GatewayStat[]>([]);
  const [packetStats, setPacketStats] = useState<PacketStat[]>([]);
  const [nodePackets, setNodePackets] = useState<Packet[]>([]);
  const [chatHistory, setChatHistory] = useState<any[]>([]); 
  const [darkMode, setDarkMode] = useState(true); 
  const [loadingPackets, setLoadingPackets] = useState(false); 
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null); 
  const [chatFilter, setChatFilter] = useState({ favoritesOnly: false, nodeId: '', searchText: '' }); 
  const [sysStatus, setSysStatus] = useState<any>(null); 
  const [appLoading, setAppLoading] = useState(true); 
  const [coverageData, setCoverageData] = useState<any[]>([]);
  const [showTraceroute, setShowTraceroute] = useState(false);
  const [showHopGrid, setShowHopGrid] = useState(false);
  const [traceroutePath, setTraceroutePath] = useState<any[]>([]);

  // Pagination states
  const packetsPerPage = 20; 
  const [globalPacketsCurrentPage, setGlobalPacketsCurrentPage] = useState(1);
  const [globalPacketsTotalCount, setGlobalPacketsTotalCount] = useState(0);
  const [nodePacketsCurrentPage, setNodePacketsCurrentPage] = useState(1);
  const [nodePacketsTotalCount, setNodePacketsTotalCount] = useState(0);
  const [favPacketsCurrentPage, setFavPacketsCurrentPage] = useState(1);
  const [favPacketsTotalCount, setFavPacketsTotalCount] = useState(0);

  const [nodeActivity, setNodeActivity] = useState<Record<string, number>>({}); 

  // 從本地瀏覽器讀取最愛清單
  const [favoriteIdSet, setFavoriteNodeIds] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('meshtastic_favorites');
    return new Set(saved ? JSON.parse(saved) : []);
  });

  // 地圖圖層開關與資料
  const [showTopology, setShowTopology] = useState(false);
  const [showUtilization, setShowUtilization] = useState(false);
  const [neighbors, setNeighbors] = useState<any[]>([]);
  const [gatewayLeaderboard, setGatewayLeaderboard] = useState<any[]>([]);

  // 封包過濾狀態
  const [nodeListSearchQuery, setNodeListSearchQuery] = useState(''); 
  const [fontSize, setFontSize] = useState('base'); 

  const [globalFilter, setGlobalFilter] = useState({ 
    port: 'ALL', 
    gateway: '', 
    minSnr: '' as number | '', 
    minRssi: '' as number | '', 
    timePreset: 'ALL', 
    startTime: '', 
    endTime: '' 
  });
  const [nodeLogFilter, setNodeLogFilter] = useState({ 
    port: 'ALL', 
    gateway: '', 
    minSnr: '' as number | '', 
    minRssi: '' as number | '', 
    timePreset: 'ALL', 
    startTime: '', 
    endTime: '' 
  });
  const [favLogFilter, setFavLogFilter] = useState({ 
    port: 'ALL', 
    gateway: '', 
    minSnr: '' as number | '', 
    minRssi: '' as number | '', 
    timePreset: 'ALL', 
    startTime: '', 
    page: 1, 
    endTime: '' 
  });
  const [gatewayFilter, setGatewayFilter] = useState({ search: '', minPackets: '' as number | '', minSnr: '' as number | '' });

  const uniquePorts = useMemo(() => Array.from(new Set(Object.values(PORTNUM_NAMES))).sort(), []);

  // 自動從節點列表中找出被選中的節點物件
  const selectedNode = useMemo(() => {
    return nodes.find(n => n.node_id === selectedNodeId) || null;
  }, [nodes, selectedNodeId]);

  const filteredNodes = useMemo(() => {
    const query = nodeListSearchQuery.toLowerCase();
    return nodes.map(n => ({ ...n, is_favorite: favoriteIdSet.has(n.node_id) ? 1 : 0 }))
      .filter(node => 
        node.node_id.toLowerCase().includes(query) ||
        (node.long_name || '').toLowerCase().includes(query) ||
        (node.short_name || '').toLowerCase().includes(query)
      );
  }, [nodes, nodeListSearchQuery, favoriteIdSet]);

  // 過濾邏輯封裝
  const applyFilter = (pkts: Packet[], filter: typeof globalFilter) => {
    return pkts.filter(p => {
      const type = PORTNUM_NAMES[p.portnum] || p.portnum;
      if (filter.port !== 'ALL' && type !== filter.port) return false;
      if (filter.gateway && !p.gateway_id?.toLowerCase().includes(filter.gateway.toLowerCase())) return false;
      
      const pTime = p.timestamp ? new Date(p.timestamp).getTime() : 0;
      const now = Date.now();
      if (filter.timePreset === '1h' && now - pTime > 3600000) return false;
      if (filter.timePreset === '6h' && now - pTime > 21600000) return false;
      if (filter.timePreset === '24h' && now - pTime > 86400000) return false;
      if (filter.timePreset === 'CUSTOM') {
        if (filter.startTime && pTime < new Date(filter.startTime).getTime()) return false;
        if (filter.endTime && pTime > new Date(filter.endTime).getTime()) return false;
      }

      if (filter.minSnr !== '' && (p.snr === undefined || p.snr < Number(filter.minSnr))) return false;
      if (filter.minRssi !== '' && (p.rssi === undefined || p.rssi < Number(filter.minRssi))) return false;
      return true;
    });
  };

  const filteredGlobalPackets = useMemo(() => applyFilter(packets, globalFilter), [packets, globalFilter]);
  const filteredNodePackets = useMemo(() => applyFilter(nodePackets, nodeLogFilter), [nodePackets, nodeLogFilter]);

  const filteredGateways = useMemo(() => {
    return gatewayLeaderboard.filter(gw => {
      if (gatewayFilter.search && !gw.gateway_id.toLowerCase().includes(gatewayFilter.search.toLowerCase())) return false;
      if (gatewayFilter.minPackets !== '' && Number(gw.total_packets) < Number(gatewayFilter.minPackets)) return false;
      if (gatewayFilter.minSnr !== '' && Number(gw.avg_snr || 0) < Number(gatewayFilter.minSnr)) return false;
      return true;
    });
  }, [gatewayLeaderboard, gatewayFilter]);

  const renderFilterBar = (filter: any, setFilter: any) => (
    <div className={`p-3 border-b grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-8 gap-3 items-end ${darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50/50 border-slate-100'}`}>
      <div className="space-y-1">
        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1 whitespace-nowrap"><Filter size={10}/> 種類 (Type)</label>
        <select value={filter.port} onChange={(e) => setFilter({ ...filter, port: e.target.value })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}>
          <option value="ALL">全部種類 (ALL)</option>
          {uniquePorts.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      
      <div className="space-y-1">
        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1 whitespace-nowrap"><Clock size={10}/> 時間範圍</label>
        <select value={filter.timePreset} onChange={(e) => setFilter({ ...filter, timePreset: e.target.value })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}>
          <option value="ALL">全部 (ALL)</option>
          <option value="1h">1 小時內</option>
          <option value="6h">6 小時內</option>
          <option value="24h">24 小時內</option>
          <option value="CUSTOM">自定義範圍</option>
        </select>
      </div>

      {filter.timePreset === 'CUSTOM' ? (
        <>
          <div className="space-y-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase">開始 (起)</label>
            <input type="datetime-local" step="3600" value={filter.startTime} onChange={(e) => setFilter({ ...filter, startTime: e.target.value })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase">結束 (止)</label>
            <input type="datetime-local" step="3600" value={filter.endTime} onChange={(e) => setFilter({ ...filter, endTime: e.target.value })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} />
          </div>
        </>
      ) : (
        <div className="hidden lg:block lg:col-span-2"></div>
      )}

      <div className="space-y-1">
        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1 whitespace-nowrap"><Signal size={10}/> Gateway ID</label>
        <input type="text" placeholder="搜尋閘道器..." value={filter.gateway} onChange={(e) => setFilter({ ...filter, gateway: e.target.value })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} />
      </div>
      
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[9px] font-bold text-slate-500 uppercase whitespace-nowrap">SNR &ge;</label>
          <input type="number" step="0.1" value={filter.minSnr} onChange={(e) => setFilter({ ...filter, minSnr: e.target.value === '' ? '' : Number(e.target.value) })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} />
        </div>
        <div className="space-y-1">
          <label className="text-[9px] font-bold text-slate-500 uppercase whitespace-nowrap">RSSI &ge;</label>
          <input type="number" value={filter.minRssi} onChange={(e) => setFilter({ ...filter, minRssi: e.target.value === '' ? '' : Number(e.target.value) })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} />
        </div>
      </div>
      <button onClick={() => setFilter({ port: 'ALL', gateway: '', minSnr: '', minRssi: '', timePreset: 'ALL', startTime: '', endTime: '' })} className={`p-1.5 rounded text-[9px] font-bold uppercase transition-colors ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-500'}`}>清除過濾</button>
    </div>
  );

  const chatEndRef = useRef<HTMLDivElement>(null); 
  const selectedNodeIdRef = useRef<string | null>(null);
  const activeTabRef = useRef(activeTab);
  const currentChatChannelRef = useRef(currentChatChannel);

  const favoriteNodes = useMemo(() => {
    return nodes
      .filter(n => favoriteIdSet.has(n.node_id))
      .map(n => ({ ...n, is_favorite: 1 }));
  }, [nodes, favoriteIdSet]);

  const chatMessages = useMemo(() => {
    const liveMsgs = packets
      .filter(p => (PORTNUM_NAMES[p.portnum] === 'TEXT_MESSAGE' || p.portnum === '1' || p.portnum === 1) && p.payload_json?.text && p.payload_json?.channel_name === currentChatChannel)
      .map(p => ({
        node_id: p.from,
        message: p.payload_json.text,
        timestamp: p.timestamp || new Date().toISOString(),
        isLive: true
      }));

    const combined = [...chatHistory, ...liveMsgs];
    return combined.filter((msg, index, self) => {
        const isUnique = index === self.findIndex((t) => (
          t.node_id === msg.node_id && t.message === msg.message && t.timestamp === msg.timestamp
        ));
        if (!isUnique) return false;

        if (chatFilter.favoritesOnly) {
          const sender = nodes.find(n => n.node_id === msg.node_id);
          if (sender?.is_favorite !== 1) return false;
        }
        
        if (chatFilter.nodeId && !msg.node_id.toLowerCase().includes(chatFilter.nodeId.toLowerCase())) {
          return false;
        }

        if (chatFilter.searchText && !msg.message.toLowerCase().includes(chatFilter.searchText.toLowerCase())) {
          return false;
        }

        return true;
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [packets, chatHistory, currentChatChannel, chatFilter, nodes]);

  const fetchNodeStatus = async () => {
    try {
      const res = await fetch('/api/node-status');
      const data = await res.json();
      setNodes(data);
      return data; 
    } catch (e) {
      console.error("Failed to fetch node status", e);
      setAppLoading(false);
      return [];
    }
  };

  const fetchPackets = useCallback(async (
    type: 'global' | 'favorite' | 'node',
    page: number,
    filter: typeof globalFilter | typeof nodeLogFilter | typeof favLogFilter,
    nodeId?: string,
    nodeIds?: string[]
  ) => {
    setLoadingPackets(true);
    try {
      let url = '';
      let countUrl = '';
      const queryParams = new URLSearchParams();

      queryParams.append('limit', packetsPerPage.toString());
      queryParams.append('page', page.toString());

      if (filter.port && filter.port !== 'ALL') queryParams.append('portnum', filter.port);
      if (filter.gateway) queryParams.append('gateway_id', filter.gateway);
      if (filter.minSnr !== '' && filter.minSnr !== undefined) queryParams.append('minSnr', filter.minSnr.toString());
      if (filter.minRssi !== '' && filter.minRssi !== undefined) queryParams.append('minRssi', filter.minRssi.toString());
      if (filter.timePreset === 'CUSTOM') {
        if (filter.startTime) queryParams.append('timeStart', filter.startTime);
        if (filter.endTime) queryParams.append('timeEnd', filter.endTime);
      } else if (filter.timePreset !== 'ALL') {
        const now = new Date();
        let timeAgo = new Date();
        if (filter.timePreset === '1h') timeAgo.setHours(now.getHours() - 1);
        if (filter.timePreset === '6h') timeAgo.setHours(now.getHours() - 6);
        if (filter.timePreset === '24h') timeAgo.setHours(now.getHours() - 24);
        queryParams.append('timeStart', timeAgo.toISOString());
        queryParams.append('timeEnd', now.toISOString());
      }

      if (type === 'global') {
        url = `/api/packets?${queryParams.toString()}`;
        countUrl = `/api/packets/count?${queryParams.toString()}`;
      } else if (type === 'node' && nodeId) {
        url = `/api/node/${encodeURIComponent(nodeId)}/packets?${queryParams.toString()}`;
        countUrl = `/api/node/${encodeURIComponent(nodeId)}/packets/count?${queryParams.toString()}`;
      } else if (type === 'favorite' && nodeIds && nodeIds.length > 0) {
        queryParams.append('node_ids', nodeIds.join(','));
        url = `/api/packets?${queryParams.toString()}`;
        countUrl = `/api/packets/count?${queryParams.toString()}`;
      } else {
        setLoadingPackets(false);
        return;
      }

      const [packetsRes, countRes] = await Promise.all([
        fetch(url),
        fetch(countUrl)
      ]);
      const packetsData = await packetsRes.json();
      const countData = await countRes.json();

      const formattedPackets = packetsData.map((p: any) => ({
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
      }));

      if (type === 'global') {
        setPackets(formattedPackets);
        setGlobalPacketsTotalCount(countData.count);
      } else if (type === 'node') {
        setNodePackets(formattedPackets);
        setNodePacketsTotalCount(countData.count);
      } else if (type === 'favorite') {
        setFavoritePackets(formattedPackets);
        setFavPacketsTotalCount(countData.count);
      }
    } catch (error) {
      console.error("Failed to fetch packets:", error);
    } finally {
      setLoadingPackets(false);
    }
  }, []);

  const fetchGlobalPackets = useCallback((page: number, filter: typeof globalFilter) => 
    fetchPackets('global', page, filter), [fetchPackets]);
  
  const fetchNodeSpecificPackets = useCallback((nodeId: string, page: number, filter: typeof nodeLogFilter) => 
    fetchPackets('node', page, filter, nodeId), [fetchPackets]);

  const fetchFavoritePackets = useCallback((page: number, filter: typeof favLogFilter, currentNodes: Node[]) => {
    if (!Array.isArray(currentNodes) || currentNodes.length === 0) return;
    const favIds = currentNodes.filter(n => n && favoriteIdSet.has(n.node_id)).map(n => n.node_id);
    if (favIds.length === 0) return;
    fetchPackets('favorite', page, filter, undefined, favIds);
  }, [fetchPackets, favoriteIdSet]);

  const loadNetworkStats = useCallback(async () => {
    try {
      const [nRes, gRes] = await Promise.all([
        fetch('/api/neighbors'), 
        fetch('/api/gateways/leaderboard')
      ]);
      setNeighbors(await nRes.json());
      setGatewayLeaderboard(await gRes.json());
    } catch (e) { console.error("Network stats load failed", e); }
  }, []);

  const refreshDashboardData = useCallback(async () => {
    try {
      const [sRes, aRes] = await Promise.all([fetch('/api/sys-status'), fetch('/api/nodes/activity')]);
      const sData = await sRes.json();
      const aData = await aRes.json();
      
      setSysStatus(sData);
      const activityMap: Record<string, number> = {};
      aData.forEach((item: any) => activityMap[item.node_id] = item.count);
      setNodeActivity(activityMap);
    } catch (e) {}
  }, []);

  const estimateBatteryLife = (node: Node) => {
    if (!node.voltage || node.voltage < 3.2) return "N/A";
    const remainingPercent = Math.max(0, (node.voltage - 3.4) / (4.1 - 3.4) * 100);
    if (node.current && node.current > 0) return `${(remainingPercent * 2000 / (node.current * 100)).toFixed(1)}h`;
    return `${remainingPercent.toFixed(0)}% 剩餘`;
  };

  const fetchNodeStats = async (nodeId: string) => {
    setLoadingPackets(true);
    setNodePacketsCurrentPage(1); 
    try {
      const [gwRes, statRes] = await Promise.all([
        fetch(`/api/node/${encodeURIComponent(nodeId)}/gateways`),
        fetch(`/api/node/${encodeURIComponent(nodeId)}/packet-stats`),
      ]);

      setGatewayStats(await gwRes.json());
      setPacketStats(await statRes.json());
    } catch (error) {
      console.error("Failed to fetch node stats:", error);
    } finally {
      setLoadingPackets(false);
    }
  }; 

  const toggleFavorite = (nodeId: string) => {
    setFavoriteNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      localStorage.setItem('meshtastic_favorites', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const handleShowModal = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setIsDetailModalOpen(true);
  };

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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
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
          <div className={`space-y-2 ${darkMode ? 'text-slate-200' : 'text-slate-800'}`}>
            <h5 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
              <MapPin size={14} className="text-green-500" /> 位置廣播 Position Broadcast
            </h5>
            <div className="h-48 rounded-xl overflow-hidden border border-slate-300 dark:border-slate-700">
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
             <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
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
        
        const routeNodes = route.map((nodeId: string) => nodes.find(n => n.node_id === nodeId)).filter(Boolean) as Node[];
        
        const points: [number, number][] = [];
        routeNodes.forEach(n => { if (n.latitude && n.longitude) points.push([n.latitude, n.longitude]); });

        return (
          <div className="space-y-2">
             <h5 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
               <Zap size={14} className="text-yellow-500" /> 路徑追蹤 Traceroute Path
             </h5>
             {points.length >= 2 ? (
               <div className="h-48 rounded-xl overflow-hidden border border-slate-300 dark:border-slate-700">
                 <MapContainer center={points[0]} zoom={10} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                   <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                   {points.map((p, idx) => (
                     <CircleMarker 
                       key={idx} 
                       center={p} 
                       radius={6} 
                       pathOptions={{ fillColor: idx === 0 ? '#eab308' : (idx === points.length - 1 ? '#ef4444' : '#3b82f6'), color: 'white', weight: 2, fillOpacity: 1 }} />
                   ))}
                   <Polyline positions={points} color="#eab308" weight={3} dashArray="5, 5" />
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
                   <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${darkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-200 text-slate-700'}`}>
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

  useEffect(() => {
    if (activeTab === 'chat') {
      fetch(`/api/chat-history/${encodeURIComponent(currentChatChannel)}?limit=${packetsPerPage}`)
        .then(res => res.json())
        .then(data => setChatHistory(data));
    }
  }, [currentChatChannel, activeTab]);

  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { currentChatChannelRef.current = currentChatChannel; }, [currentChatChannel]);

  const hasAnyUnreadChat = useMemo(() => Object.values(unreadChannels).some(v => v), [unreadChannels]);

  useEffect(() => {
    console.log("App.tsx: useEffect - Initializing app...");
    const initApp = async () => {
      setAppLoading(true);
      try {
        const initialNodes = await fetchNodeStatus();
        await Promise.all([
          loadNetworkStats(),
          refreshDashboardData(),
          fetchGlobalPackets(globalPacketsCurrentPage, globalFilter),
          fetchFavoritePackets(favPacketsCurrentPage, favLogFilter, initialNodes)
        ]);
      } catch (error) {
        console.error("Initial app load failed:", error);
      } finally {
        setAppLoading(false);
      }
    };
    initApp();

    socket.on('mqtt_status', (data) => setMqttConnected(data.connected));

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

    socket.on('raw_packet', (packet) => {
      const now = new Date();
      packet.timestamp = now.toISOString();
      packet.time = now.toLocaleTimeString('zh-TW', { hour12: false });
      
      // 🎯 修正：只有非中繼站 (MQTT) 來源才更新地圖 Marker 的座標，中繼封包僅用於染色
      setNodes(prev => prev.map(n => n.node_id === packet.from ? { 
        ...n, 
        latitude: !packet.source ? (packet.latitude || n.latitude) : n.latitude, 
        longitude: !packet.source ? (packet.longitude || n.longitude) : n.longitude,
        last_seen: now.toISOString()
      } : n));

      // 📍 當收到 Position 封包 (Port 3) 時，立即刷新網格數據
      const isPos = (PORTNUM_NAMES[packet.portnum] === 'POSITION' || packet.portnum === 3 || packet.portnum === '3');
      if (isPos) {
        setTimeout(() => fetch('/api/coverage/griddata').then(res => res.json()).then(setCoverageData), 1000);
      }

      // 🚀 隱身術：只有非中繼站（MQTT）的封包才放入「封包觀察」清單
      if (!packet.source) {
        setPackets(prev => {
          const formattedPkt = {
            ...packet,
            payload_json: packet.payload_json ? (typeof packet.payload_json === 'string' ? JSON.parse(packet.payload_json) : packet.payload_json) : null
          };
          return [formattedPkt, ...prev].slice(0, 50); 
        });
      }

      if (selectedNodeIdRef.current && packet.from === selectedNodeIdRef.current) {
        setNodePackets(prev => [packet, ...prev].slice(0, 20));
      }

      const isText = (PORTNUM_NAMES[packet.portnum] === 'TEXT_MESSAGE' || packet.portnum === '1' || packet.portnum === 1);
      if (isText && packet.payload_json?.text && packet.payload_json?.channel_name) {
        const msgChan = packet.payload_json.channel_name;
        if (activeTabRef.current !== 'chat' || currentChatChannelRef.current !== msgChan) {
          setUnreadChannels(prev => ({ ...prev, [msgChan]: true }));
        }
      }
    });

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

    // 抓取網格化聚合數據
    fetch('/api/coverage/griddata').then(res => res.json()).then(setCoverageData);

    // 抓取 Traceroute 數據
    const fetchTraceroute = () => fetch('/api/traceroute/latest').then(res => res.json()).then(setTraceroutePath);
    fetchTraceroute();

    const sysInterval = setInterval(refreshDashboardData, 30000); 
    const coverageInterval = setInterval(() => {
      fetch('/api/coverage/griddata').then(res => res.json()).then(setCoverageData);
    }, 120000); // 每 2 分鐘更新一次地圖背景點位
    const tracerouteInterval = setInterval(fetchTraceroute, 60000); // 每分鐘更新最新路徑

    return () => { 
      socket.off('mqtt_status');
      socket.off('node_seen');
      socket.off('raw_packet');
      socket.off('telemetry_update');
      clearInterval(sysInterval);
      clearInterval(coverageInterval);
      clearInterval(tracerouteInterval);
    };
  }, [fetchGlobalPackets, fetchFavoritePackets, loadNetworkStats, refreshDashboardData, globalPacketsCurrentPage, globalFilter, favPacketsCurrentPage, favLogFilter]);

  useEffect(() => {
    fetchGlobalPackets(globalPacketsCurrentPage, globalFilter);
  }, [fetchGlobalPackets, globalPacketsCurrentPage, globalFilter]);

  useEffect(() => {
    if (selectedNodeId) {
      fetchNodeStats(selectedNodeId);
      fetchNodeSpecificPackets(selectedNodeId, nodePacketsCurrentPage, nodeLogFilter);
    }
  }, [selectedNodeId, nodePacketsCurrentPage, nodeLogFilter, fetchNodeSpecificPackets]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const favInterval = setInterval(() => fetchFavoritePackets(favPacketsCurrentPage, favLogFilter, nodes), 60000);
    return () => clearInterval(favInterval);
  }, [fetchFavoritePackets, favPacketsCurrentPage, favLogFilter, nodes]);

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

  return (
    <div className={`min-h-screen flex flex-col transition-colors duration-300 ${darkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans text-${fontSize}`}>
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
          <select value={fontSize} onChange={(e) => setFontSize(e.target.value)} className={`bg-transparent border-none text-white text-xs outline-none`}>
            <option value="sm" className="bg-slate-800">小字體</option>
            <option value="base" className="bg-slate-800">中字體</option>
            <option value="lg" className="bg-slate-800">大字體</option>
          </select>
        </div>
      </nav>

      {/* Tabs Menu */}
      <div className={`border-b sticky top-0 z-50 shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="max-w-6xl mx-auto flex overflow-x-auto no-scrollbar whitespace-nowrap">
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
          <button 
            onClick={() => setActiveTab('gateways')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'gateways' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Signal size={16} /> 閘道監控
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
        </div>
      </div>

      {appLoading && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/90 backdrop-blur-sm text-white">
          <div className="flex flex-col items-center">
            <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-cyan-500"></div>
            <p className="mt-4 text-lg font-bold text-cyan-400">載入中，請稍候...</p>
            <p className="text-sm text-slate-400">正在初始化雷達站數據</p>
          </div>
        </div>
      )}

      {!appLoading && (
        <div className="flex-1 flex flex-col">
          <main className="flex-1 w-full">
            {activeTab === 'nodes' && (
              <div className="max-w-7xl mx-auto p-6 space-y-6 text-sm">
                <div className="relative max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input 
                    type="text" 
                    placeholder="快速搜尋節點..." 
                    className={`w-full pl-10 pr-4 py-2 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 outline-none text-sm transition-colors ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
                    value={nodeListSearchQuery}
                    onChange={(e) => setNodeListSearchQuery(e.target.value)}
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
                        <th className="px-6 py-4">24h 密度</th>
                        <th className="px-6 py-4 whitespace-nowrap">最後活動</th>
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
                            <button onClick={() => toggleFavorite(node.node_id)} className={node.is_favorite ? 'text-yellow-500' : 'text-slate-300 hover:text-slate-400'}>
                              <Star fill={node.is_favorite ? "currentColor" : "none"} size={18} />
                            </button>
                          </td>
                          <td className="px-6 py-4 font-mono font-bold text-cyan-600 text-xs">
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
                          <td className="px-6 py-4 text-xs">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-black truncate max-w-[120px] ${darkMode ? 'text-slate-100' : 'text-slate-900'}`}>{node.long_name || 'Unknown'}</span>
                              <span className="text-[10px] font-bold text-cyan-500 bg-cyan-500/10 px-1 rounded">({node.short_name || 'N/A'})</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-mono border uppercase tracking-tighter ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                              {node.hw_model?.replace(/_/g, ' ') || 'UNKNOWN'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-xs">
                            <div className={`text-[10px] max-w-[120px] truncate font-bold ${darkMode ? 'text-cyan-400/80' : 'text-cyan-700'}`} title={node.last_topic}>
                              {(() => {
                                const rawChannel = node.channel || '';
                                const isInvalid = /^\d+$/.test(rawChannel) || ['c', 'json', 'e', 'stat', ''].includes(rawChannel);
                                const channelName = isInvalid ? (() => {
                                    const parts = (node.last_topic || '').split('/');
                                    return parts.find(p => !/^\d+$/.test(p) && !['msh', 'TW', 'c', 'json', 'e', 'stat', ''].includes(p) && !p.startsWith('!')) || '-';
                                })() : rawChannel;
                                return channelName === 'MediumFast' ? '⚡ ' + channelName : channelName;
                              })()}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className={`text-[11px] font-black ${nodeActivity[node.node_id] > 50 ? 'text-orange-500' : 'text-slate-400'}`}>
                                {nodeActivity[node.node_id] || 0} <span className="text-[9px] font-normal opacity-60">pkts</span>
                              </span>
                              <div className="w-12 h-1 bg-slate-200 dark:bg-slate-800 rounded-full mt-1 overflow-hidden">
                                <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, (nodeActivity[node.node_id] || 0) * 2)}%` }}></div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-xs font-medium text-slate-500 whitespace-nowrap text-right">
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
              <div className={`flex flex-col h-[75vh] rounded-2xl border shadow-xl overflow-hidden text-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                <div className={`px-4 pt-4 border-b ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-white'}`}>
                  <div className="flex justify-between items-center mb-4">
                    <div className="flex items-center gap-2">
                      <MessageCircle className="text-cyan-500" size={20} />
                      <h3 className="font-black uppercase tracking-widest text-sm">Mesh Messager</h3>
                    </div>
                    <button 
                      onClick={fetchPackets} 
                      className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                      title="重新整理數據"
                    >
                      <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  
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
                
                <div className={`px-4 py-2 border-b flex flex-wrap gap-4 items-center ${darkMode ? 'bg-slate-800/30 border-slate-800' : 'bg-slate-100/50 border-slate-200'}`}>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setChatFilter(prev => ({ ...prev, favoritesOnly: !prev.favoritesOnly }))}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black transition-all border ${
                        chatFilter.favoritesOnly 
                          ? 'bg-yellow-500 border-yellow-400 text-white shadow-[0_0_8px_rgba(234,179,8,0.4)]' 
                          : darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-white border-slate-200 text-slate-500'
                      }`}
                    >
                      <Star size={12} fill={chatFilter.favoritesOnly ? "currentColor" : "none"} /> 僅最愛
                    </button>
                  </div>

                  <div className="flex items-center gap-3 flex-1 min-w-[200px]">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" size={12} />
                      <input 
                        type="text" 
                        placeholder="搜尋文字內容..." 
                        value={chatFilter.searchText}
                        onChange={(e) => setChatFilter(prev => ({ ...prev, searchText: e.target.value }))}
                        className={`w-full pl-7 pr-2 py-1.5 rounded-lg border text-[10px] outline-none transition-all focus:ring-1 focus:ring-cyan-500 ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600' : 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400'}`}
                      />
                    </div>
                    <div className="relative flex-1">
                      <Smartphone className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" size={12} />
                      <input 
                        type="text" 
                        placeholder="篩選節點 ID..." 
                        value={chatFilter.nodeId}
                        onChange={(e) => setChatFilter(prev => ({ ...prev, nodeId: e.target.value }))}
                        className={`w-full pl-7 pr-2 py-1.5 rounded-lg border text-[10px] outline-none transition-all focus:ring-1 focus:ring-cyan-500 ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600' : 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400'}`}
                      />
                    </div>
                    {(chatFilter.favoritesOnly || chatFilter.nodeId || chatFilter.searchText) && (
                      <button 
                        onClick={() => setChatFilter({ favoritesOnly: false, nodeId: '', searchText: '' })}
                        className={`p-1.5 rounded-full transition-colors ${darkMode ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
                        title="清除過濾"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin">
                  {chatMessages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 italic">
                      <MessageCircle size={48} className="mb-4 opacity-10" />
                      <p>{(chatFilter.favoritesOnly || chatFilter.nodeId || chatFilter.searchText) ? "找不到符合條件的訊息" : "尚無文字訊息紀錄"}</p>
                    </div>
                  )}
                  {chatMessages.map((msg, idx) => {
                    const sender = nodes.find(n => n.node_id === msg.node_id);
                    const isFavorite = sender?.is_favorite === 1;
                    
                    return (
                      <div key={idx} className={`flex ${isFavorite ? 'justify-end' : 'justify-start'} w-full animate-in fade-in slide-in-from-bottom-2`}>
                        <div className={`flex gap-3 max-w-[80%] ${isFavorite ? 'flex-row-reverse' : 'flex-row'}`}>
                          <div 
                            onClick={() => handleShowModal(msg.node_id)}
                            className={`w-10 h-10 rounded-full flex items-center justify-center text-[10px] font-black border-2 flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity ${isFavorite ? 'bg-cyan-500 border-cyan-400 text-white' : 'bg-slate-700 border-slate-600 text-slate-300'}`}
                          >
                            {sender?.short_name || '??'}
                          </div>
                          
                          <div className={`flex flex-col ${isFavorite ? 'items-end' : 'items-start'}`}>
                            <div className="flex items-center gap-2 mb-1 px-1">
                              <button onClick={() => handleShowModal(msg.node_id)} className={`text-[10px] font-bold hover:underline ${isFavorite ? 'text-yellow-500' : 'text-cyan-500'}`}>
                                {msg.node_id} {sender?.long_name ? `(${sender.long_name})` : ''}
                              </button>
                              <span className="text-[9px] text-slate-500 font-mono">
                                {(() => {
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
                <div className="flex justify-between items-center border-b border-slate-200 dark:border-slate-800 pb-4">
                  <h2 className="text-2xl font-bold flex items-center gap-2 text-yellow-500">
                    <Star size={28} fill="currentColor" /> 最愛節點監控面板 ({favoriteNodes.length})
                  </h2>
                  <button 
                    onClick={fetchPackets} 
                    className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                    title="重新整理數據"
                  >
                    <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                  </button>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {favoriteNodes.length > 0 ? favoriteNodes.map(node => {
                    const diffHours = (Date.now() - new Date(node.last_seen).getTime()) / 3600000;
                    let status = { color: 'text-green-500', glow: 'shadow-[0_0_20px_rgba(34,197,94,0.3)]', border: 'border-green-500/30', offline: false, msg: '' };
                    
                    if (diffHours < 6) {
                      status = { color: 'text-green-500', glow: 'shadow-[0_0_20px_rgba(34,197,94,0.35)]', border: 'border-green-500/50', offline: false, msg: '通訊良好' };
                    } else if (diffHours < 12) {
                      status = { color: 'text-yellow-500', glow: 'shadow-[0_0_20px_rgba(234,179,8,0.35)]', border: 'border-yellow-500/50', offline: false, msg: '有一陣子沒看見了' };
                    } else if (diffHours < 24) {
                      status = { color: 'text-red-500', glow: 'shadow-[0_0_20px_rgba(239,68,68,0.35)]', border: 'border-red-500/50', offline: false, msg: '失蹤邊緣' };
                    } else {
                      const wittyMsgs = ["大概是去外星旅行了", "冬眠中，請勿打擾", "能量耗盡，正在流浪", "進入異世界通訊範圍"];
                      status = { color: 'text-slate-500', glow: '', border: 'border-slate-700', offline: true, msg: wittyMsgs[Math.floor(node.node_id.length % wittyMsgs.length)] };
                    }

                    return (
                      <div 
                        key={node.node_id} 
                        onClick={() => handleShowModal(node.node_id)}
                        className={`group relative p-5 rounded-2xl border-2 transition-all flex flex-col gap-4 cursor-pointer hover:scale-[1.02] ${status.glow} ${status.border} ${status.offline ? 'grayscale opacity-60' : ''} ${darkMode ? 'bg-slate-900' : 'bg-white'}`}
                      >
                      {status.offline && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] px-3 py-0.5 rounded-full font-black border border-slate-600 shadow-lg z-10 whitespace-nowrap">
                          📡 {status.msg}
                        </div>
                      )}

                      <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="px-1.5 py-0.5 bg-yellow-500 text-white text-[9px] font-black rounded uppercase tracking-wider shadow-sm">{node.node_id}</span>
                            <span className={`text-[9px] font-mono border rounded px-1.5 py-0.5 uppercase tracking-tighter ${darkMode ? 'bg-slate-950 border-slate-700 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                              {node.hw_model?.replace(/_/g, ' ') || 'UNKNOWN'}
                            </span>
                          </div>
                          <h3 className={`text-lg font-black truncate leading-tight ${darkMode ? 'text-slate-100' : 'text-slate-900'}`}>{node.long_name || 'Unknown'}</h3>
                          <p className="text-xs text-blue-500 font-bold opacity-80">({node.short_name || '??'})</p>
                          
                          {node.last_gateway && (
                            <div className="mt-2 flex items-center gap-1.5 opacity-60">
                              <Signal size={10} className="text-slate-400" />
                              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-tighter">Via: {node.last_gateway}</span>
                            </div>
                          )}
                        </div>
                        <button 
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(node.node_id); }} 
                          className="text-yellow-500 p-2 hover:scale-110 transition-transform bg-yellow-500/10 rounded-full"
                          title="從最愛移除"
                        >
                          <Star fill="currentColor" size={24} />
                        </button>
                      </div>

                      <div className={`grid grid-cols-3 gap-px overflow-hidden rounded-xl border ${darkMode ? 'bg-slate-800 border-slate-800' : 'bg-slate-200 border-slate-200'}`}>
                        <div className={`flex flex-col items-center py-3 ${darkMode ? 'bg-slate-900' : 'bg-white'}`}>
                          <Battery size={16} className="text-green-500 mb-1" />
                          <span className="text-[9px] text-slate-500 uppercase font-black">電量</span>
                          <span className={`text-sm font-black ${darkMode ? 'text-slate-200' : 'text-slate-700'}`}>{node.battery_level ?? '--'}%</span>
                          <div className="text-[8px] text-cyan-500 font-bold mt-1 flex items-center gap-1">
                            <TrendingDown size={8} />
                            {estimateBatteryLife(node)}
                          </div>
                        </div>
                        <div className={`flex flex-col items-center py-3 ${darkMode ? 'bg-slate-900' : 'bg-white'}`}>
                          <Zap size={16} className="text-amber-500 mb-1" />
                          <span className="text-[9px] text-slate-500 uppercase font-black">電壓</span>
                          <span className={`text-sm font-black ${darkMode ? 'text-slate-200' : 'text-slate-700'}`}>{node.voltage?.toFixed(2) ?? '--'}V</span>
                        </div>
                        <div className={`flex flex-col items-center py-3 ${darkMode ? 'bg-slate-900' : 'bg-white'}`}>
                          <Activity size={16} className="text-purple-500 mb-1" />
                          <span className="text-[9px] text-slate-500 uppercase font-black">電流</span>
                          <span className={`text-sm font-black ${darkMode ? 'text-slate-200' : 'text-slate-700'}`}>{node.current?.toFixed(0) ?? '--'}mA</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className={`flex items-center justify-between px-3 py-2 rounded-xl ${darkMode ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
                          <div className="flex items-center gap-2">
                            <Sun size={14} className="text-orange-400" />
                            <span className="text-[10px] text-slate-500 font-bold">環境溫度</span>
                          </div>
                          <span className={`text-xs font-black ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>{node.temperature?.toFixed(1) ?? '--'}°C</span>
                        </div>
                        <div className={`flex items-center justify-between px-3 py-2 rounded-xl ${darkMode ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
                          <div className="flex items-center gap-2">
                            <Signal size={14} className="text-blue-400" />
                            <span className="text-[10px] text-slate-500 font-bold">環境濕度</span>
                          </div>
                          <span className={`text-xs font-black ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>{node.humidity?.toFixed(0) ?? '--'}%</span>
                        </div>
                      </div>

                      <div className="mt-auto pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center text-[10px]">
                        <div className={`flex items-center gap-1.5 font-bold ${status.color}`}>
                          <Clock size={12} />
                          <span>{new Date(node.last_seen).toLocaleString()}</span>
                        </div>
                        <button 
                          onClick={(e) => { e.stopPropagation(); setSelectedNodeId(node.node_id); setActiveTab('details'); }}
                          className="px-3 py-1 bg-cyan-500/10 text-cyan-500 rounded-full font-black hover:bg-cyan-500 hover:text-white transition-all uppercase tracking-widest"
                        >
                          進入詳情
                        </button>
                      </div>
                    </div>
                  )}) : (
                    <div className="col-span-full py-20 text-center text-slate-400 italic">
                      尚無收藏節點。點擊節點清單中的星星圖示來加入收藏。
                    </div>
                  )}
                </div>

                <div className="space-y-4 pt-4">
                  <h3 className="text-sm font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
                    <MapIcon size={18} className="text-cyan-500" /> 成員地理分佈 (Static Map)
                  </h3>
                  <div className={`h-[400px] rounded-2xl overflow-hidden border-2 shadow-inner relative ${darkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-100 bg-white'}`}>
                    <NodeMap 
                      nodes={favoriteNodes} 
                      onSelectNode={handleShowModal}
                      activeTab={activeTab}
                      coverageData={coverageData}
                      showTraceroute={showTraceroute}
                      showHopGrid={showHopGrid}
                    />
                  </div>
                </div>

                <div className="space-y-4 pt-4">
                  <div className={`rounded-xl shadow-sm border overflow-hidden text-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <div className={`p-4 border-b flex justify-between items-center ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                      <h3 className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
                        <Database size={16} className="text-cyan-500" /> 成員通訊追蹤
                      </h3>
                      <button
                        onClick={fetchPackets} 
                        className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                        title="重新整理數據"
                      >
                        <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                      </button>
                    </div>
                    {renderFilterBar(favLogFilter, setFavLogFilter)}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[11px] font-mono border-collapse">
                        <thead className={`${darkMode ? 'bg-slate-800/30 text-slate-400' : 'bg-slate-100 text-slate-500'} border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                          <tr>
                            <th className="p-3">時間</th>
                            <th className="p-3">發送者</th>
                            <th className="p-3">種類</th>
                            <th className="p-3">Gateway</th>
                            <th className="p-3 text-center">SNR/RSSI</th>
                            <th className="p-3 text-right">詳情</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'} text-xs`}>
                          {favoritePackets.map((p, i) => {
                            const senderNode = nodes.find(n => n.node_id === p.from);
                            const gwNode = nodes.find(n => n.node_id === p.gateway_id);
                            return (
                              <tr key={i} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}>
                                <td className="p-3 text-slate-400">{p.time}</td>
                                <td className="p-3">
                                  <button 
                                    onClick={() => handleShowModal(p.from)}
                                    className="text-yellow-500 font-bold hover:underline text-left"
                                  >
                                    {p.from} ({senderNode?.short_name || '??'})
                                  </button>
                                </td>
                                <td className="p-3">
                                  <div className="flex items-center gap-2">
                                    {p.portnum === 'ENCRYPTED' ? (
                                      <span className={`px-1.5 py-0.5 rounded border font-bold text-[9px] ${darkMode ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-red-50 border-red-100 text-red-600'}`}>
                                        PRIVATE
                                      </span>
                                    ) : (
                                      <span className={`px-1.5 py-0.5 rounded border font-bold text-[9px] ${darkMode ? 'bg-slate-800 border-slate-700 text-cyan-400' : 'bg-blue-50 border-blue-100 text-blue-600'}`}>
                                        {PORTNUM_NAMES[p.portnum] || p.portnum}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="p-3">
                                  <button 
                                    onClick={() => p.gateway_id && handleShowModal(p.gateway_id)}
                                    className={`font-bold hover:underline ${darkMode ? 'text-slate-400' : 'text-slate-600'}`}
                                  >
                                    {p.gateway_id || 'Unknown'} {gwNode ? `(${gwNode.short_name})` : ''}
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
                      {favoritePackets.length === 0 && (
                        <div className="p-10 text-center text-slate-400 italic text-sm">
                          {loadingPackets ? "載入中..." : "無符合條件的成員封包"}
                        </div>
                      )}
                    </div>
                    <div className={`p-4 border-t flex justify-end items-center gap-4 ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                      <span className="text-xs text-slate-500">總計 {favPacketsTotalCount} 筆</span>
                      <button onClick={() => setFavPacketsCurrentPage(prev => Math.max(1, prev - 1))} disabled={favPacketsCurrentPage === 1 || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'} disabled:opacity-50`}>上一頁</button>
                      <span className="text-xs font-bold text-slate-400">{favPacketsCurrentPage} / {Math.ceil(favPacketsTotalCount / packetsPerPage) || 1}</span>
                      <button onClick={() => setFavPacketsCurrentPage(prev => prev + 1)} disabled={favPacketsCurrentPage * packetsPerPage >= favPacketsTotalCount || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'} disabled:opacity-50`}>下一頁</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'details' && (
              <div className="space-y-6">
                {selectedNode ? (
                  <div className={`rounded-xl shadow-sm border overflow-hidden text-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <div className="bg-slate-900 p-6 text-white flex justify-between items-center">
                      <div>
                        <div className="text-3xl font-black tracking-tight flex items-center gap-3">
                          {selectedNode.long_name}
                          <span className="text-blue-400 text-lg">({selectedNode.short_name})</span>
                          <button onClick={() => toggleFavorite(selectedNode.node_id)} className={selectedNode.is_favorite ? 'text-yellow-500 ml-2' : 'text-white/40 ml-2 hover:text-white/80'}>
                            <Star fill={selectedNode.is_favorite ? "currentColor" : "none"} size={24} />
                          </button>
                        </div>
                        <div className="text-slate-400 text-sm font-mono mt-1">ID: {selectedNode.node_id} | Topic: {selectedNode.last_topic}</div>
                      </div>
                      <div className="flex items-center gap-4 text-right">
                        <button 
                          onClick={() => fetchNodeStats(selectedNode!.node_id)} 
                          className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                          title="重新整理節點數據"
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
                      <section>
                        <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} node={selectedNode} darkMode={darkMode} />
                      </section>

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
                              activeTab={activeTab}
                              isDetailView={true}
                              onSelectNode={() => {}} 
                              coverageData={coverageData}
                              showTraceroute={showTraceroute}
                              showHopGrid={showHopGrid}
                            />
                          ) : (
                            <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
                              此節點尚未回報 GPS 位置
                            </div>
                          )}
                        </div>
                      </section>

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

                      <section>
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                          <Database size={14} /> 節點封包紀錄 (MQTT Trace)
                        </h4>
                        {renderFilterBar(nodeLogFilter, (newFilter: typeof nodeLogFilter) => { setNodeLogFilter(newFilter); setNodePacketsCurrentPage(1); })}
                        <div className={`border rounded-xl overflow-hidden mb-10 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
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
                              {filteredNodePackets.map((p, i) => {
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
                                            const v = pwr?.ch1_voltage ?? pwr?.ch1Voltage;
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
                        {filteredNodePackets.length === 0 && <div className="p-10 text-center text-slate-300 italic">無符合過濾條件之紀錄</div>}
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
              <div className="space-y-6">
                <div className={`rounded-xl border shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-white border-slate-200'}`}>
                  <div className="p-4 flex flex-wrap justify-between items-center gap-4"> 
                    <div className="flex gap-4 items-center">
                      <button 
                        onClick={() => setShowTopology(!showTopology)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showTopology ? 'bg-cyan-500 border-cyan-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <Zap size={12}/> 拓撲圖層
                      </button>
                      <button 
                        onClick={() => setShowUtilization(!showUtilization)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showUtilization ? 'bg-orange-500 border-orange-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <Activity size={12}/> 利用率圖層
                      </button>
                      <button 
                        onClick={() => setShowTraceroute(!showTraceroute)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showTraceroute ? 'bg-amber-500 border-amber-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <Zap size={12}/> 覆蓋範圍
                      </button>
                      <button 
                        onClick={() => setShowHopGrid(!showHopGrid)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showHopGrid ? 'bg-green-600 border-green-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <TrendingDown size={12}/> 跳轉分析
                      </button>
                    </div>
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
                  </div>
                </div>

                <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                    Map Visualization: {mapShowFavoritesOnly ? favoriteNodes.length : nodes.length} Nodes
                </div>

                <div className={`w-full h-[70vh] rounded-2xl overflow-hidden border shadow-sm relative transition-colors ${darkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'}`}>
                  <NodeMap
                    nodes={mapShowFavoritesOnly ? favoriteNodes : nodes} 
                    onSelectNode={handleShowModal} 
                      activeTab={activeTab}
                    onShowDetail={handleShowModal}
                    showTopology={showTopology}
                    showUtilization={showUtilization}
                    showTraceroute={showTraceroute}
                    showHopGrid={showHopGrid}
                    traceroutePath={traceroutePath} 
                    neighbors={neighbors}
                    coverageData={coverageData}
                  />
                </div>
              </div>
            )}

            {isDetailModalOpen && selectedNode && (
              <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
                <div 
                  className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" 
                  onClick={() => setIsDetailModalOpen(false)}
                ></div>
                
                <div className={`relative rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto flex flex-col border text-sm ${darkMode ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'}`}>
                  <div className={`sticky top-0 p-6 flex justify-between items-center z-10 border-b ${darkMode ? 'bg-slate-900 text-white border-slate-800' : 'bg-slate-900 text-white'}`}>
                    <div>
                      <div className="text-2xl font-black tracking-tight flex items-center gap-3">
                        {selectedNode.long_name}
                        <span className="text-blue-400 text-lg">({selectedNode.short_name})</span>
                        <button onClick={() => toggleFavorite(selectedNode.node_id)} className={selectedNode.is_favorite ? 'text-yellow-500' : 'text-slate-500 hover:text-slate-400'}>
                          <Star fill={selectedNode.is_favorite ? "currentColor" : "none"} size={20} />
                        </button>
                      </div>
                      <button 
                        onClick={() => {
                          setSelectedNodeId(selectedNode.node_id);
                          setActiveTab('details');
                          setIsDetailModalOpen(false);
                        }}
                        className="text-slate-400 text-sm font-mono mt-1 hover:text-blue-400"
                      >
                        ID: {selectedNode.node_id}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => fetchNodeStats(selectedNode.node_id)} 
                        className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                        title="重新整理節點數據"
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

                  <div className="p-6 space-y-8">
                    <section>
                      <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} node={selectedNode} darkMode={darkMode} />
                    </section>

                    <section>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                        <MapIcon size={14} /> 節點位置
                      </h4>
                      <div className="h-[400px] rounded-xl overflow-hidden border border-slate-200">
                        {selectedNode.latitude || gatewayStats.length > 0 ? (
                          <NodeMap 
                            nodes={[selectedNode]} 
                            allNodes={nodes} 
                            gateways={gatewayStats}
                            activeTab={activeTab}
                            isDetailView={true}
                            onSelectNode={() => {}} 
                            coverageData={coverageData}
                            showTraceroute={showTraceroute}
                            showHopGrid={showHopGrid}
                          />
                        ) : (
                          <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
                            此節點尚未回報 GPS 位置
                          </div>
                        )}
                      </div>
                    </section>

                    <section>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                        <PieChart size={14} className="text-blue-500" /> 封包種類分布
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
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

                    <section>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Signal size={14} className="text-green-500" /> 途經閘道統計
                      </h4>
                      <div className={`border rounded-xl max-h-[300px] overflow-y-auto relative shadow-sm text-xs ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
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

                    <section>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                        <Database size={14} /> 節點封包紀錄 (MQTT Trace)
                      </h4>
                        {renderFilterBar(nodeLogFilter, (newFilter: typeof nodeLogFilter) => { setNodeLogFilter(newFilter); setNodePacketsCurrentPage(1); })}
                      <div className={`border rounded-xl overflow-hidden mb-10 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                        <table className="w-full text-left text-[11px] font-mono">
                          <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                            {filteredNodePackets.map((p, i) => {
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
                                        const pwr = p.payload_json.power_metrics || p.payload_json.powerMetrics;
                                        if (!m) return '';
                                        const v = pwr?.ch1_voltage ?? pwr?.ch1Voltage;
                                        return `${m.battery_level ?? m.batteryLevel ?? '?'}% ${v ? v.toFixed(2) + 'V' : ''} | AU:${(m.air_util_tx ?? m.airUtilTx ?? 0).toFixed(1)}% CU:${(m.channel_utilization ?? m.channelUtilization ?? 0).toFixed(1)}%`;
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
                        {/* Pagination for node-specific packets */}
                        <div className={`p-4 border-t flex justify-end items-center gap-4 ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                          <span className="text-xs text-slate-500">總計 {nodePacketsTotalCount} 筆</span>
                          <button onClick={() => setNodePacketsCurrentPage(prev => Math.max(1, prev - 1))} disabled={nodePacketsCurrentPage === 1 || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'} disabled:opacity-50`}>上一頁</button>
                          <span className="text-xs font-bold text-slate-400">{nodePacketsCurrentPage} / {Math.ceil(nodePacketsTotalCount / packetsPerPage) || 1}</span>
                          <button onClick={() => setNodePacketsCurrentPage(prev => prev + 1)} disabled={nodePacketsCurrentPage * packetsPerPage >= nodePacketsTotalCount || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'} disabled:opacity-50`}>下一頁</button>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'logs' && (
              <div className="space-y-6 text-sm">
                <div className={`rounded-xl shadow-sm border overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                  <div className={`p-4 border-b flex justify-between items-center ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                    <h3 className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
                      <Database size={16} className="text-cyan-500" /> 全域封包觀察 (Global Packet Tracking)
                    </h3>
                    <button 
                      onClick={fetchPackets} 
                      className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                      title="重新整理數據"
                    >
                      <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  {renderFilterBar(globalFilter, (newFilter: typeof globalFilter) => { setGlobalFilter(newFilter); setGlobalPacketsCurrentPage(1); })}
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
                        {filteredGlobalPackets.map((p, i) => {
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
                    {filteredGlobalPackets.length === 0 && <div className="p-20 text-center text-slate-400 italic">無符合過濾條件之封包...</div>}
                  </div>
                  <div className={`p-4 border-t flex justify-end items-center gap-4 ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                    <span className="text-xs text-slate-500">總計 {globalPacketsTotalCount} 筆</span>
                    <button onClick={() => setGlobalPacketsCurrentPage(prev => Math.max(1, prev - 1))} disabled={globalPacketsCurrentPage === 1 || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'} disabled:opacity-50`}>上一頁</button>
                    <span className="text-xs font-bold text-slate-400">{globalPacketsCurrentPage} / {Math.ceil(globalPacketsTotalCount / packetsPerPage) || 1}</span>
                    <button onClick={() => setGlobalPacketsCurrentPage(prev => prev + 1)} disabled={globalPacketsCurrentPage * packetsPerPage >= globalPacketsTotalCount || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'} disabled:opacity-50`}>下一頁</button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'gateways' && (
              <div className="space-y-6 animate-in fade-in duration-500">
                <div className={`rounded-xl shadow-lg border overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                  <div className={`p-4 border-b flex justify-between items-center ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                    <h2 className="text-xl font-black flex items-center gap-3">
                      <Signal size={24} className="text-cyan-500" /> MQTT 閘道排行榜 (Gateways Leaderboard)
                    </h2>
                    <button 
                      onClick={async () => {
                        setLoadingPackets(true);
                        try {
                          const res = await fetch('/api/gateways/leaderboard');
                          const data = await res.json();
                          setGatewayLeaderboard(data);
                        } catch (e) { console.error(e); }
                        finally { setLoadingPackets(false); }
                      }} 
                      className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400"
                      title="重新整理數據"
                    >
                      <RefreshCw size={20} className={loadingPackets ? 'animate-spin' : ''} />
                    </button>
                  </div>

                  <div className={`p-3 border-b grid grid-cols-1 sm:grid-cols-3 gap-4 items-end ${darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50/50 border-slate-100'}`}>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1"><Search size={10}/> 搜尋 ID</label>
                      <input 
                        type="text" placeholder="搜尋閘道器..." value={gatewayFilter.search} 
                        onChange={(e) => setGatewayFilter({ ...gatewayFilter, search: e.target.value })} 
                        className={`w-full p-1.5 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} 
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1"><Database size={10}/> 最少封包</label>
                      <input 
                        type="number" value={gatewayFilter.minPackets} 
                        onChange={(e) => setGatewayFilter({ ...gatewayFilter, minPackets: e.target.value === '' ? '' : Number(e.target.value) })} 
                        className={`w-full p-1.5 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} 
                      />
                    </div>
                    <div className="flex gap-2 items-end">
                      <div className="space-y-1 flex-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1"><Signal size={10}/> 最低 SNR</label>
                        <input 
                          type="number" step="0.1" value={gatewayFilter.minSnr} 
                          onChange={(e) => setGatewayFilter({ ...gatewayFilter, minSnr: e.target.value === '' ? '' : Number(e.target.value) })} 
                          className={`w-full p-1.5 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`} 
                        />
                      </div>
                      <button 
                        onClick={() => setGatewayFilter({ search: '', minPackets: '', minSnr: '' })} 
                        className={`p-2 rounded text-[9px] font-bold uppercase transition-colors ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-500'}`}
                      >重置</button>
                    </div>
                  </div>

                  <table className="w-full text-left">
                    <thead className={`${darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'} text-[10px] font-black uppercase tracking-widest`}>
                      <tr>
                        <th className="px-6 py-4">排名</th>
                        <th className="px-6 py-4">閘道器 ID</th>
                        <th className="px-6 py-4 text-center">總處理封包</th>
                        <th className="px-6 py-4 text-center">平均 SNR</th>
                        <th className="px-6 py-4">最後活動</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                      {filteredGateways.map((gw, idx) => (
                        <tr key={gw.gateway_id} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}>
                          <td className="px-6 py-4 font-black text-slate-500">#{(idx + 1).toString().padStart(2, '0')}</td>
                          <td className="px-6 py-4">
                            <button onClick={() => handleShowModal(gw.gateway_id)} className="font-mono font-bold text-cyan-500 hover:underline">
                              {gw.gateway_id}
                            </button>
                          </td>
                          <td className="px-6 py-4 text-center font-black">{gw.total_packets}</td>
                          <td className={`px-6 py-4 text-center font-bold ${gw.avg_snr > 5 ? 'text-green-500' : 'text-orange-500'}`}>
                            {gw.avg_snr ? Number(gw.avg_snr).toFixed(2) : '0.00'}
                          </td>
                          <td className="px-6 py-4 text-xs text-slate-400">
                            {gw.last_active ? new Date(gw.last_active).toLocaleString() : 'N/A'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredGateways.length === 0 && (
                    <div className="p-20 text-center text-slate-400 italic">尚未統計到符合條件的閘道資料</div>
                  )}
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
            
          </main>

          <footer className={`mt-auto p-4 border-t text-[10px] font-bold ${darkMode ? 'bg-slate-900/50 border-slate-800 text-slate-500' : 'bg-white border-slate-100 text-slate-400'}`}>
            <div className="max-w-7xl mx-auto flex flex-wrap justify-between items-center gap-4">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-1.5"><Cpu size={12} className="text-cyan-500"/> 系統負載: {sysStatus?.cpu_load?.[0]?.toFixed(2) || '--'}</div>
                <div className="flex items-center gap-1.5"><Database size={12} className="text-purple-500"/> 程序記憶體: {sysStatus?.memory ? (sysStatus.memory.rss / 1024 / 1024).toFixed(1) : '--'} MB</div>
                <div className="flex items-center gap-1.5"><HardDrive size={12} className="text-emerald-500"/> 資料庫大小: {sysStatus?.db_size ? (sysStatus.db_size / 1024 / 1024).toFixed(2) : '--'} MB</div>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-1.5 uppercase tracking-widest">
                  <Activity size={12} className="text-orange-500" /> 
                  連續運行時間: {sysStatus?.uptime ? `${Math.floor(sysStatus.uptime / 3600)}h ${Math.floor((sysStatus.uptime % 3600) / 60)}m` : '--'} 
                </div>
                <div className="hidden sm:block opacity-30 tracking-[0.2em]">MESHTASTIC RADAR ENGINE v1.0</div>
              </div>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}

export default App;