import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Activity, Star, Radio, Search, Clock, Zap, Map as MapIcon, List, BarChart3, Info, Database, Signal, HardDrive, Smartphone, Battery, ZapOff, PieChart, X, Sun, Moon, Terminal, Eye, Cpu, RefreshCw, MessageCircle, MapPin, Filter, TrendingDown, Settings, Megaphone, Share2, Maximize2, Minimize2 } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup } from 'react-leaflet';
import type { TraceroutePath } from './NodeMap';
import PacketTypePieChart from './PacketTypePieChart';
import NodeRecoveryQR from './NodeRecoveryQR';

const NodeMap = React.lazy(() => import('./NodeMap'));
const TelemetryCharts = React.lazy(() => import('./TelemetryCharts'));
const RfHealthChart = React.lazy(() => import('./RfHealthChart'));
const TopologyGraph = React.lazy(() => import('./TopologyGraph'));
const NetworkAnalytics = React.lazy(() => import('./NetworkAnalytics'));
import { throttle } from 'lodash';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  title?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 my-6 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-400 flex flex-col items-center justify-center min-h-[300px] gap-4">
          <div className="p-3 bg-red-500/20 rounded-full text-red-400 animate-bounce">
            ⚠️
          </div>
          <h3 className="font-bold text-base text-red-300">
            {this.props.title || '此分頁載入時發生異常 (Tab Execution Error)'}
          </h3>
          <p className="text-xs font-mono text-red-300/80 bg-slate-900/60 p-3 rounded-lg border border-red-500/20 max-w-xl text-center overflow-auto">
            {this.state.error?.message || '未知執行階段例外'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg transition flex items-center gap-2"
          >
            🔄 重新載入分頁
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  id?: number;           // 🚀 DB row id 用於懶加載詳情
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

// 🚀 最愛群組功能介面
interface FavoriteGroup {
  id: string;
  name: string;
  color: string; // e.g. 'cyan', 'yellow', 'green', 'orange', 'pink', 'purple'
  nodeIds: string[];
}

interface FavoritesConfig {
  version: 2;
  groups: FavoriteGroup[];
  ungrouped: string[];
}

// 群組可用顏色選項
const GROUP_COLORS = [
  { key: 'cyan', label: '青', bg: 'bg-cyan-500', text: 'text-cyan-400', border: 'border-cyan-500' },
  { key: 'yellow', label: '黃', bg: 'bg-yellow-500', text: 'text-yellow-400', border: 'border-yellow-500' },
  { key: 'green', label: '綠', bg: 'bg-green-500', text: 'text-green-400', border: 'border-green-500' },
  { key: 'orange', label: '橙', bg: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-500' },
  { key: 'pink', label: '粉', bg: 'bg-pink-500', text: 'text-pink-400', border: 'border-pink-500' },
  { key: 'purple', label: '紫', bg: 'bg-purple-500', text: 'text-purple-400', border: 'border-purple-500' },
  { key: 'red', label: '紅', bg: 'bg-red-500', text: 'text-red-400', border: 'border-red-500' },
  { key: 'blue', label: '藍', bg: 'bg-blue-500', text: 'text-blue-400', border: 'border-blue-500' },
];

function getColorMeta(key: string) {
  return GROUP_COLORS.find(c => c.key === key) || GROUP_COLORS[0];
}

// localStorage helpers
function loadFavoritesConfig(): FavoritesConfig {
  // 嘗試讀新格式
  const v2 = localStorage.getItem('meshtastic_favorites_v2');
  if (v2) {
    try { return JSON.parse(v2); } catch (_) { }
  }
  // 迅移舊格式
  const v1 = localStorage.getItem('meshtastic_favorites');
  const oldIds: string[] = v1 ? JSON.parse(v1) : [];
  return { version: 2, groups: [], ungrouped: oldIds };
}

function saveFavoritesConfig(cfg: FavoritesConfig) {
  localStorage.setItem('meshtastic_favorites_v2', JSON.stringify(cfg));
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
const ITEMS_PER_PAGE = 20;

const ANNOUNCEMENT_TITLE = "📢 v2.4 重大版本更新公告";
const ANNOUNCEMENT_TEXT = `歡迎來到 Meshtastic DashBoard v2.4！

本次更新重點：
1. 📱 聯絡人 QR Code 產生器：新增 Contact QR 功能，解決 App 掃描後節點隱藏問題，完美相容並支援置頂。
2. 🗺️ 地圖重疊點優化：引入防抖發散演算法，解決重疊節點點擊展開與彈窗關閉的 Bug。
3. ⚡ 效能與 API 優化：後端啟用 gzip 壓縮，大幅優化 telemetry 查詢效能。
4. 📦 按需載入與分流打包：前端採用 Lazy-loading 載入地圖與圖表，首屏載入速度提升 80% 以上。

聯絡作者 : qq32170514@gmail.com (歡迎交流與提供建議)
`;

const socket = io();

const SearchInput = ({ value, onChange, placeholder, icon, label, darkMode, type = "text", list }: any) => {
  const [localValue, setLocalValue] = useState(value || '');
  
  useEffect(() => {
    setLocalValue(value || '');
  }, [value]);

  const handleApply = () => {
    if (localValue !== (value || '')) {
      onChange(localValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleApply();
    }
  };

  return (
    <div className="space-y-1">
      <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1 whitespace-nowrap">
        {icon} {label}
      </label>
      <div className="relative">
        <input
          type={type}
          placeholder={placeholder}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleApply}
          className={`w-full p-1 pr-6 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}
          list={list}
        />
        <button
          onClick={handleApply}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-500 p-0.5"
          title="搜尋 (Enter)"
        >
          <Search size={10} />
        </button>
      </div>
    </div>
  );
};

// ===================================================
// 🚀 FilterBar — 必須定義在 App 元件外部
// 定義在元件內部會導致每次父元件重新渲染時 React 視之為
// 不同的元件類型，強制 unmount/remount 並丟失本地狀態。
// ===================================================
const uniquePorts = Array.from(new Set(Object.values(PORTNUM_NAMES))).sort();

interface FilterBarProps {
  filter: any;
  setFilter: (f: any) => void;
  darkMode: boolean;
}

const FilterBar = ({ filter, setFilter, darkMode }: FilterBarProps) => {
  const [pendingStart, setPendingStart] = useState(filter.startTime || '');
  const [pendingEnd, setPendingEnd] = useState(filter.endTime || '');

  // 當外部 filter 的 timePreset 改變時，同步 pending state
  useEffect(() => {
    if (filter.timePreset !== 'CUSTOM') {
      setPendingStart('');
      setPendingEnd('');
    }
    // 注意：不在 CUSTOM 模式下同步回去，避免使用者輸入被覆蓋
  }, [filter.timePreset]);

  const applyCustomDate = () => {
    setFilter({ ...filter, startTime: pendingStart, endTime: pendingEnd });
  };

  return (
    <div className={`p-3 border-b grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-8 gap-3 items-end ${darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50/50 border-slate-100'}`}>
      <div className="space-y-1">
        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1 whitespace-nowrap"><Filter size={10} /> 種類 (Type)</label>
        <select value={filter.port} onChange={(e) => setFilter({ ...filter, port: e.target.value })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}>
          <option value="ALL">全部種類 (ALL)</option>
          {uniquePorts.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1 whitespace-nowrap"><Clock size={10} /> 時間範圍</label>
        <select value={filter.timePreset} onChange={(e) => setFilter({ ...filter, timePreset: e.target.value, startTime: '', endTime: '' })} className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}>
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
            <input
              type="datetime-local"
              step="3600"
              value={pendingStart}
              onChange={(e) => setPendingStart(e.target.value)}
              className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase">結束 (止)</label>
            <input
              type="datetime-local"
              step="3600"
              value={pendingEnd}
              onChange={(e) => setPendingEnd(e.target.value)}
              className={`w-full p-1 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}
            />
          </div>
        </>
      ) : (
        <div className="hidden lg:block lg:col-span-2"></div>
      )}

      <SearchInput
        value={filter.gateway}
        onChange={(val: string) => setFilter({ ...filter, gateway: val })}
        placeholder="搜尋閘道器..."
        icon={<Signal size={10} />}
        label="Gateway ID"
        darkMode={darkMode}
        list="node-list"
      />

      <SearchInput
        value={filter.sender || ''}
        onChange={(val: string) => setFilter({ ...filter, sender: val })}
        placeholder="搜尋發送者 ID..."
        icon={<Smartphone size={10} />}
        label="發送者 (Sender)"
        darkMode={darkMode}
        list="node-list"
      />

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
      <div className="flex gap-1.5 items-center">
        {filter.timePreset === 'CUSTOM' && (
          <button
            onClick={applyCustomDate}
            className={`flex-1 p-1.5 rounded text-[9px] font-black uppercase transition-colors whitespace-nowrap ${darkMode ? 'bg-cyan-700 hover:bg-cyan-600 border border-cyan-600 text-white' : 'bg-cyan-500 hover:bg-cyan-400 border border-cyan-400 text-white'}`}
            title="套用自定義日期範圍"
          >
            ✓ 確定
          </button>
        )}
        <button
          onClick={() => setFilter({ port: 'ALL', gateway: '', sender: '', minSnr: '', minRssi: '', timePreset: 'ALL', startTime: '', endTime: '' })}
          className={`flex-1 p-1.5 rounded text-[9px] font-bold uppercase transition-colors whitespace-nowrap ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700' : 'bg-slate-100 hover:bg-slate-200 text-slate-500 border border-slate-200'}`}
        >
          清除過濾
        </button>
      </div>
    </div>
  );
};

function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [favoritePackets, setFavoritePackets] = useState<Packet[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'analytics' | 'favorites' | 'nodes' | 'details' | 'map' | 'logs' | 'chat' | 'gateways'>('favorites');
  const [nodeListSubTab, setNodeListSubTab] = useState<'list' | 'analytics'>('list');
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
  // 🚀 懶加載封包詳情（payload_json + raw_hex）
  const [selectedPacketDetail, setSelectedPacketDetail] = useState<any>(null);
  const [loadingPacketDetail, setLoadingPacketDetail] = useState(false);
  const [selectedPacketGateways, setSelectedPacketGateways] = useState<any[]>([]);
  const [loadingPacketGateways, setLoadingPacketGateways] = useState(false);
  const [chatFilter, setChatFilter] = useState({ favoritesOnly: false, nodeId: '', searchText: '' });
  const [showChatAnalytics, setShowChatAnalytics] = useState(false);
  const [chatAnalyticsData, setChatAnalyticsData] = useState<any>(null);
  const [sysStatus, setSysStatus] = useState<any>(null);
  const [displayedUptime, setDisplayedUptime] = useState<number | null>(null);
  const [appLoading, setAppLoading] = useState(true);
  const [coverageData, setCoverageData] = useState<any[]>([]);
  const [showTraceroute, setShowTraceroute] = useState(false);
  const [showHopGrid, setShowHopGrid] = useState(false);
  const [traceroutePath, setTraceroutePath] = useState<any[]>([]);
  const [selectedNodePath, setSelectedNodePath] = useState<any[]>([]);
  const [showTrackerHistory, setShowTrackerHistory] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const [fusionEdges, setFusionEdges] = useState<any[]>([]);
  const [traceroutePaths, setTraceroutePaths] = useState<TraceroutePath[]>([]);
  const [mapFavoriteGroup, setMapFavoriteGroup] = useState<string>('all');
  const [isMapFullScreen, setIsMapFullScreen] = useState(false);
  const [mapSearchText, setMapSearchText] = useState('');
  const [mapCenterCoords, setMapCenterCoords] = useState<[number, number] | undefined>(undefined);
  const [coverageStartTime, setCoverageStartTime] = useState('');
  const [coverageEndTime, setCoverageEndTime] = useState('');
  // Pagination states
  const packetsPerPage = 20;
  const [globalPacketsCurrentPage, setGlobalPacketsCurrentPage] = useState(1);
  const [globalPacketsTotalCount, setGlobalPacketsTotalCount] = useState(0);
  const [nodePacketsCurrentPage, setNodePacketsCurrentPage] = useState(1);
  const [nodePacketsTotalCount, setNodePacketsTotalCount] = useState(0);
  const [favPacketsCurrentPage, setFavPacketsCurrentPage] = useState(1);
  const [favPacketsTotalCount, setFavPacketsTotalCount] = useState(0);

  const [nodeActivity, setNodeActivity] = useState<Record<string, number>>({});

  // 🚀 效能優化版的 WebSocket 監聽器
  useEffect(() => {
    socket.on('connect', () => setMqttConnected(true));
    socket.on('disconnect', () => setMqttConnected(false));

    const handleNodeUpdate = throttle((data: Node | Node[]) => {
      setNodes(prev => {
        const incoming = Array.isArray(data) ? data : [data];
        const newNodes = [...prev];
        let changed = false;

        incoming.forEach(node => {
          const idx = newNodes.findIndex(n => n.node_id === node.node_id);
          if (idx >= 0) {
            newNodes[idx] = { ...newNodes[idx], ...node };
            changed = true;
          } else {
            newNodes.push(node);
            changed = true;
          }
        });

        return changed ? newNodes : prev;
      });
    }, 1000, { leading: true, trailing: true });

    const handlePacketBatch = throttle((data: any[]) => {
      if (!data || data.length === 0) return;

      setPackets(prev => {
        const combined = [...data, ...prev];
        // 最多保留最新 300 筆，避免 DOM 崩潰
        return combined.slice(0, 300);
      });
    }, 1000, { leading: true, trailing: true });

    //socket.on('node_update', handleNodeUpdate);
    //socket.on('raw_packet_batch', handlePacketBatch);

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('node_update');
      socket.off('raw_packet_batch');
      handleNodeUpdate.cancel();
      handlePacketBatch.cancel();
    };
  }, []);

  // 🚀 效能優化：O(1) 節點查找 Map（取代小表 O(n) 的 .find()）
  const nodeMap = useMemo(() => {
    const map = new Map<string, Node>();
    nodes.forEach(n => map.set(n.node_id, n));
    return map;
  }, [nodes]);

  // 🚀 效能優化：日期格式化 helper（避免在 map 中重複渰譜）
  const formatTimestamp = useCallback((ts: any) => {
    if (!ts) return '';
    const str = String(ts);
    const dateStr = str.includes(' ') ? str.replace(' ', 'T') + 'Z' : str;
    return new Date(dateStr).toLocaleString();
  }, []);

  // 🚀 最愛群組完整狀態管理
  const [favConfig, setFavConfig] = useState<FavoritesConfig>(() => loadFavoritesConfig());

  // 群組相關 UI 狀態
  const [activeFavGroupId, setActiveFavGroupId] = useState<'all' | 'ungrouped' | string>('all');
  const [isGroupManagerOpen, setIsGroupManagerOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('cyan');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  // 節點卡片上的「移至群組」下拉顯示狀態
  const [groupDropdownNodeId, setGroupDropdownNodeId] = useState<string | null>(null);

  // 將 favConfig 派生成 favoriteIdSet（向下相容，全區用）
  const favoriteIdSet = useMemo<Set<string>>(() => {
    const all = new Set<string>(favConfig?.ungrouped || []);
    if (Array.isArray(favConfig?.groups)) {
      favConfig.groups.forEach(g => {
        if (Array.isArray(g?.nodeIds)) {
          g.nodeIds.forEach(id => all.add(id));
        }
      });
    }
    return all;
  }, [favConfig]);

  // 將 favConfig 派生成當前分頁展示的節點列表
  const currentGroupNodeIds = useMemo<Set<string>>(() => {
    if (activeFavGroupId === 'all') return favoriteIdSet;
    if (activeFavGroupId === 'ungrouped') return new Set(favConfig?.ungrouped || []);
    const g = Array.isArray(favConfig?.groups) ? favConfig.groups.find(g => g.id === activeFavGroupId) : null;
    return new Set(g?.nodeIds || []);
  }, [activeFavGroupId, favConfig, favoriteIdSet]);

  // 群組操作函數
  const saveFav = useCallback((updater: (prev: FavoritesConfig) => FavoritesConfig) => {
    setFavConfig(prev => {
      const next = updater(prev);
      saveFavoritesConfig(next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((nodeId: string) => {
    saveFav(prev => {
      const isCurrentlyFav = favoriteIdSet.has(nodeId);
      const groups = Array.isArray(prev?.groups) ? prev.groups : [];
      const ungrouped = Array.isArray(prev?.ungrouped) ? prev.ungrouped : [];
      if (isCurrentlyFav) {
        // 移除：從 ungrouped 和所有群組移除
        return {
          ...prev,
          ungrouped: ungrouped.filter(id => id !== nodeId),
          groups: groups.map(g => ({ ...g, nodeIds: (Array.isArray(g.nodeIds) ? g.nodeIds : []).filter(id => id !== nodeId) }))
        };
      } else {
        // 加入：放到 ungrouped
        return { ...prev, ungrouped: [...ungrouped, nodeId] };
      }
    });
  }, [favoriteIdSet, saveFav]);

  const assignNodeToGroup = useCallback((nodeId: string, groupId: 'ungrouped' | string) => {
    saveFav(prev => {
      const groups = Array.isArray(prev?.groups) ? prev.groups : [];
      const ungrouped = Array.isArray(prev?.ungrouped) ? prev.ungrouped : [];
      // 先從所有組和 ungrouped 移除
      const cleanGroups = groups.map(g => ({ ...g, nodeIds: (Array.isArray(g.nodeIds) ? g.nodeIds : []).filter(id => id !== nodeId) }));
      const cleanUngrouped = ungrouped.filter(id => id !== nodeId);
      if (groupId === 'ungrouped') {
        return { ...prev, groups: cleanGroups, ungrouped: [...cleanUngrouped, nodeId] };
      }
      return {
        ...prev,
        ungrouped: cleanUngrouped,
        groups: cleanGroups.map(g => g.id === groupId ? { ...g, nodeIds: [...(Array.isArray(g.nodeIds) ? g.nodeIds : []), nodeId] } : g)
      };
    });
    setGroupDropdownNodeId(null);
  }, [saveFav]);

  const addGroup = useCallback((name: string, color: string) => {
    if (!name.trim()) return;
    const id = `grp_${Date.now()}`;
    saveFav(prev => ({ ...prev, groups: [...(Array.isArray(prev?.groups) ? prev.groups : []), { id, name: name.trim(), color, nodeIds: [] }] }));
    setNewGroupName('');
  }, [saveFav]);

  const deleteGroup = useCallback((groupId: string) => {
    saveFav(prev => {
      const groups = Array.isArray(prev?.groups) ? prev.groups : [];
      const ungrouped = Array.isArray(prev?.ungrouped) ? prev.ungrouped : [];
      const g = groups.find(g => g.id === groupId);
      return {
        ...prev,
        groups: groups.filter(g => g.id !== groupId),
        ungrouped: [...ungrouped, ...(g?.nodeIds || [])]
      };
    });
    if (activeFavGroupId === groupId) setActiveFavGroupId('all');
  }, [saveFav, activeFavGroupId]);

  const renameGroup = useCallback((groupId: string, newName: string) => {
    if (!newName.trim()) return;
    saveFav(prev => ({
      ...prev,
      groups: (Array.isArray(prev?.groups) ? prev.groups : []).map(g => g.id === groupId ? { ...g, name: newName.trim() } : g)
    }));
    setEditingGroupId(null);
  }, [saveFav]);

  // 匹出指定節點屬於哪個群組
  const getNodeGroupId = useCallback((nodeId: string): 'ungrouped' | string => {
    if (!favConfig || !Array.isArray(favConfig.groups)) return 'ungrouped';
    const g = favConfig.groups.find(g => Array.isArray(g?.nodeIds) && g.nodeIds.includes(nodeId));
    return g ? g.id : 'ungrouped';
  }, [favConfig]);

  // 匯出 my_favorite.txt
  const exportFavorites = useCallback(() => {
    const data = {
      ...favConfig,
      exportedAt: new Date().toISOString(),
      generator: 'Meshtastic Dashboard'
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my_favorite.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [favConfig]);

  // 匯入 my_favorite.txt
  const importFavorites = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string);
        if (parsed.version !== 2 || !Array.isArray(parsed.groups)) {
          alert('檔案格式不正確，請確認是由本系統匯出的 my_favorite.txt');
          return;
        }
        const cfg: FavoritesConfig = { version: 2, groups: parsed.groups, ungrouped: parsed.ungrouped || [] };
        saveFavoritesConfig(cfg);
        setFavConfig(cfg);
        setActiveFavGroupId('all');
        alert(`匯入成功！${cfg.groups.length} 個群組，共 ${favoriteIdSet.size} 個最愛節點已回復。`);
      } catch (_) {
        alert('檔案解析失敗，請確認檔案內容正確。');
      }
    };
    reader.readAsText(file);
  }, [favoriteIdSet.size]);


  // 地圖圖層開關與資料
  const [showLogicGraph, setShowLogicGraph] = useState(false);
  const [showNodes, setShowNodes] = useState(true);
  const [showUtilization, setShowUtilization] = useState(false);
  const [neighbors, setNeighbors] = useState<any[]>([]);
  const [gatewayLeaderboard, setGatewayLeaderboard] = useState<any[]>([]);

  // 封包過濾狀態
  const [nodeListSearchQuery, setNodeListSearchQuery] = useState('');
  const [fontSize, setFontSize] = useState('base');
  const [showAnnouncement, setShowAnnouncement] = useState(() => {
    return localStorage.getItem('hideAnnouncement_v2_2') !== 'true';
  });
  const [hideAnnouncementNextTime, setHideAnnouncementNextTime] = useState(false);

  // --- SNR 加權動態 Hop 覆蓋範圍模擬器狀態 ---
  const [simState, setSimState] = useState({ sourceNodeId: '', maxHops: 3, minSnr: -20 });
  const [simResultMap, setSimResultMap] = useState<Map<string, { hop: number, pathSnr: number }>>(new Map());
  const [simSearchText, setSimSearchText] = useState('');


  const [globalFilter, setGlobalFilter] = useState({
    port: 'ALL',
    gateway: '',
    sender: '',
    minSnr: '' as number | '',
    minRssi: '' as number | '',
    timePreset: 'ALL',
    startTime: '',
    endTime: ''
  });
  const [nodeLogFilter, setNodeLogFilter] = useState({
    port: 'ALL',
    gateway: '',
    sender: '',
    minSnr: '' as number | '',
    minRssi: '' as number | '',
    timePreset: 'ALL',
    startTime: '',
    endTime: ''
  });
  const [favLogFilter, setFavLogFilter] = useState({
    port: 'ALL',
    gateway: '',
    sender: '',
    minSnr: '' as number | '',
    minRssi: '' as number | '',
    timePreset: 'ALL',
    startTime: '',
    page: 1,
    endTime: ''
  });
  const [gatewayFilter, setGatewayFilter] = useState({ search: '', minPackets: '' as number | '', minSnr: '' as number | '' });
  const [nodeFilter, setNodeFilter] = useState({ role: 'ALL', hardware: 'ALL', timePreset: 'ALL' });

  const uniquePorts = useMemo(() => Array.from(new Set(Object.values(PORTNUM_NAMES))).sort(), []);
  // 注意：uniquePorts 也在模組層級定義供 FilterBar 元件使用（filterbar 在 App 外部）

  // 自動從節點列表中找出被選中的節點物件
  const selectedNode = useMemo(() => {
    const n = nodes.find(n => n.node_id === selectedNodeId);
    if (!n) return null;
    return { ...n, is_favorite: favoriteIdSet.has(n.node_id) ? 1 : 0 };
  }, [nodes, selectedNodeId, favoriteIdSet]);

  const uniqueRoles = useMemo(() => Array.from(new Set(nodes.map(n => n.role).filter(Boolean))).sort(), [nodes]);
  const uniqueHardware = useMemo(() => Array.from(new Set(nodes.map(n => n.hw_model).filter(Boolean))).sort(), [nodes]);

  const filteredNodes = useMemo(() => {
    const query = nodeListSearchQuery.toLowerCase();
    const now = Date.now();
    return nodes.map(n => ({ ...n, is_favorite: favoriteIdSet.has(n.node_id) ? 1 : 0 }))
      .filter(node => {
        if (query && !node.node_id.toLowerCase().includes(query) &&
          !(node.long_name || '').toLowerCase().includes(query) &&
          !(node.short_name || '').toLowerCase().includes(query)) {
          return false;
        }
        if (nodeFilter.role !== 'ALL' && node.role !== nodeFilter.role) return false;
        if (nodeFilter.hardware !== 'ALL' && node.hw_model !== nodeFilter.hardware) return false;
        if (nodeFilter.timePreset !== 'ALL' && node.last_seen) {
          const lastSeenTime = new Date(node.last_seen).getTime();
          if (nodeFilter.timePreset === '1h' && now - lastSeenTime > 3600000) return false;
          if (nodeFilter.timePreset === '6h' && now - lastSeenTime > 21600000) return false;
          if (nodeFilter.timePreset === '24h' && now - lastSeenTime > 86400000) return false;
          if (nodeFilter.timePreset === '7d' && now - lastSeenTime > 604800000) return false;
        }
        return true;
      });
  }, [nodes, nodeListSearchQuery, favoriteIdSet, nodeFilter]);

  // 過濾邏輯封裝
  const applyFilter = (pkts: Packet[], filter: typeof globalFilter) => {
    return pkts.filter(p => {
      const type = PORTNUM_NAMES[p.portnum] || p.portnum;
      if (filter.port !== 'ALL' && type !== filter.port) return false;
      if (filter.gateway) {
        const q = filter.gateway.toLowerCase();
        const n = nodes.find(n => n.node_id === p.gateway_id);
        const matchesId = p.gateway_id?.toLowerCase().includes(q);
        const matchesName = n && ((n.long_name && n.long_name.toLowerCase().includes(q)) || (n.short_name && n.short_name.toLowerCase().includes(q)));
        if (!matchesId && !matchesName) return false;
      }
      if (filter.sender) {
        const q = filter.sender.toLowerCase();
        const n = nodes.find(n => n.node_id === p.from);
        const matchesId = p.from?.toLowerCase().includes(q);
        const matchesName = n && ((n.long_name && n.long_name.toLowerCase().includes(q)) || (n.short_name && n.short_name.toLowerCase().includes(q)));
        if (!matchesId && !matchesName) return false;
      }

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

  // 前端過濾器：只對 SNR/RSSI/時間做二次過濾（Gateway/Sender 已由後端 API 過濾完畢）
  const filteredGlobalPackets = useMemo(() => packets, [packets]);
  const filteredNodePackets = useMemo(() => nodePackets, [nodePackets]);

  const filteredGateways = useMemo(() => {
    return gatewayLeaderboard.filter(gw => {
      if (gatewayFilter.search && !gw.gateway_id.toLowerCase().includes(gatewayFilter.search.toLowerCase())) return false;
      if (gatewayFilter.minPackets !== '' && Number(gw.total_packets) < Number(gatewayFilter.minPackets)) return false;
      if (gatewayFilter.minSnr !== '' && Number(gw.avg_snr || 0) < Number(gatewayFilter.minSnr)) return false;
      return true;
    });
  }, [gatewayLeaderboard, gatewayFilter]);


  const renderFilterBar = (filter: any, setFilter: any) => (
    <FilterBar filter={filter} setFilter={setFilter} darkMode={darkMode} />
  );


  const chatEndRef = useRef<HTMLDivElement>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const activeTabRef = useRef(activeTab);
  const currentChatChannelRef = useRef(currentChatChannel);
  // 當任何過濾條件啟動時，禁止 WebSocket 即時封包污染查詢結果
  const filterActiveRef = useRef(false);
  const nodeFilterActiveRef = useRef(false);

  // 同步 filterActiveRef
  useEffect(() => {
    const f = globalFilter;
    filterActiveRef.current = f.port !== 'ALL' || !!f.gateway || !!f.sender ||
      f.minSnr !== '' || f.minRssi !== '' || f.timePreset !== 'ALL';
  }, [globalFilter]);

  useEffect(() => {
    const f = nodeLogFilter;
    nodeFilterActiveRef.current = f.port !== 'ALL' || !!f.gateway || !!f.sender ||
      f.minSnr !== '' || f.minRssi !== '' || f.timePreset !== 'ALL';
  }, [nodeLogFilter]);

  const favoriteNodes = useMemo(() => {
    return nodes
      .filter(n => currentGroupNodeIds.has(n.node_id))
      .map(n => ({ ...n, is_favorite: 1 }));
  }, [nodes, currentGroupNodeIds]);

  const mapNodes = useMemo(() => {
    if (!mapShowFavoritesOnly) return nodes;
    let allowedIds = new Set<string>();
    if (mapFavoriteGroup === 'all') {
      allowedIds = favoriteIdSet;
    } else if (mapFavoriteGroup === 'ungrouped') {
      allowedIds = new Set(favConfig.ungrouped);
    } else {
      const g = favConfig.groups.find(group => group.id === mapFavoriteGroup);
      allowedIds = new Set(g?.nodeIds || []);
    }
    return nodes
      .filter(n => allowedIds.has(n.node_id))
      .map(n => ({ ...n, is_favorite: 1 }));
  }, [nodes, mapShowFavoritesOnly, mapFavoriteGroup, favoriteIdSet, favConfig]);

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

      if (chatFilter.favoritesOnly && !favoriteIdSet.has(msg.node_id)) {
        return false;
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
      // Ensure SQLite UTC timestamps are parsed correctly in local timezone by appending 'Z'
      const formattedNodes = data.map((n: any) => ({
        ...n,
        last_seen: n.last_seen && typeof n.last_seen === 'string' && n.last_seen.includes(' ') && !n.last_seen.endsWith('Z') 
          ? n.last_seen.replace(' ', 'T') + 'Z' 
          : n.last_seen
      }));
      setNodes(formattedNodes);
      return formattedNodes;
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
      if (filter.sender) queryParams.append('sender', filter.sender);
      if (filter.minSnr !== '' && filter.minSnr !== undefined) queryParams.append('minSnr', filter.minSnr.toString());
      if (filter.minRssi !== '' && filter.minRssi !== undefined) queryParams.append('minRssi', filter.minRssi.toString());
      
      const formatToUTCString = (dateObj: Date) => dateObj.toISOString().replace('T', ' ').substring(0, 19);

      if (filter.timePreset === 'CUSTOM') {
        if (filter.startTime) queryParams.append('timeStart', formatToUTCString(new Date(filter.startTime)));
        if (filter.endTime) queryParams.append('timeEnd', formatToUTCString(new Date(filter.endTime)));
      } else if (filter.timePreset !== 'ALL') {
        const now = new Date();
        let timeAgo = new Date();
        if (filter.timePreset === '1h') timeAgo.setHours(now.getHours() - 1);
        if (filter.timePreset === '6h') timeAgo.setHours(now.getHours() - 6);
        if (filter.timePreset === '24h') timeAgo.setHours(now.getHours() - 24);
        queryParams.append('timeStart', formatToUTCString(timeAgo));
        queryParams.append('timeEnd', formatToUTCString(now));
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
        id: p.id,          // 🚀 保留 DB row id 用於懶加載
        from: p.node_id,
        portnum: p.portnum,
        topic: p.topic,
        time: (() => {
          const rawTs = p.timestamp ? String(p.timestamp) : '';
          const dateStr = rawTs.includes(' ') ? rawTs.replace(' ', 'T') + 'Z' : rawTs;
          const d = new Date(dateStr);
          const datePart = `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`;
          const timePart = d.toLocaleTimeString('zh-TW', { hour12: false });
          return `${datePart} ${timePart}`;
        })(),
        timestamp: p.timestamp,
        snr: p.snr,
        rssi: p.rssi,
        gateway_id: p.gateway_id,
        source: p.source,
        // 🚀 不在列表解析 payload_json，改由點開詳情時懶加載
        rawData: undefined,
        payload_json: undefined,
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

  /**
   * 🚀 懶加載封包詳情：點開封包時才 fetch payload_json + raw_hex
   * 列表查詢已排除這兩個大欄位，大幅減少傳輸量
   */
  const openPacketDetail = useCallback(async (packet: Packet) => {
    setSelectedPacket(packet);
    setSelectedPacketDetail(null);
    setSelectedPacketGateways([]);
    // 如果封包是從 WebSocket 即時進來的（有 payload_json），直接用
    if (packet.payload_json !== undefined) {
      setSelectedPacketDetail({ payload_json: packet.payload_json, rawData: packet.rawData });
      return;
    }
    // 否則從 API 懶加載（同時取得封包詳情與所有收到該封包的 gateway）
    if (!packet.id) return;
    setLoadingPacketDetail(true);
    setLoadingPacketGateways(true);
    try {
      const [res, gwRes] = await Promise.all([
        fetch(`/api/packets/${packet.id}`),
        fetch(`/api/packets/${packet.id}/gateways`)
      ]);
      const detail = await res.json();
      const gwData = await gwRes.json();
      setSelectedPacketDetail({
        payload_json: detail.payload_json,
        rawData: detail.raw_hex
      });
      setSelectedPacketGateways(Array.isArray(gwData) ? gwData : []);
    } catch (e) {
      console.error('Failed to load packet detail:', e);
    } finally {
      setLoadingPacketDetail(false);
      setLoadingPacketGateways(false);
    }
  }, []);


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
      // 🚀 以伺服器回傳的 uptime 作為起點，之後由本地計時器每秒遞增
      if (sData?.uptime != null) setDisplayedUptime(sData.uptime);
      const activityMap: Record<string, number> = {};
      aData.forEach((item: any) => activityMap[item.node_id] = item.count);
      setNodeActivity(activityMap);
    } catch (e) { }
  }, []);

  // 🚀 每秒遞增 displayedUptime，讓頁面底部的連續運行時間動態計時
  useEffect(() => {
    if (displayedUptime == null) return;
    const timer = setInterval(() => {
      setDisplayedUptime(prev => (prev != null ? prev + 1 : prev));
    }, 1000);
    return () => clearInterval(timer);
  }, [displayedUptime == null]);


  const estimateBatteryLife = (node: Node) => {
    if (!node?.voltage || typeof node.voltage !== 'number' || node.voltage < 3.2) return "N/A";
    const remainingPercent = Math.max(0, (node.voltage - 3.4) / (4.1 - 3.4) * 100);
    if (typeof node.current === 'number' && node.current > 0) return `${(remainingPercent * 2000 / (node.current * 100)).toFixed(1)}h`;
    return `${remainingPercent.toFixed(0)}% 剩餘`;
  };

  const fetchNodeStats = async (nodeId: string) => {
    setLoadingPackets(true);
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

  const handleShowModal = (nodeId: string) => {
    if (selectedNodeId !== nodeId) {
      setNodePacketsCurrentPage(1);
    }
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
                  <span className="text-slate-400 font-medium uppercase tracking-tighter text-[9px]">{String(key).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}</span>
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
              <MapContainer key={`pos-map-${lat}-${lon}`} center={[lat, lon]} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                <TileLayer 
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" 
                />
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
                <MapContainer key={`route-map-${points.map(p=>p.join(',')).join('|')}`} center={points[0]} zoom={10} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                  <TileLayer 
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" 
                  />
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

  // 🚀 Fetch Tracker History (Always load path for the selected node when selected)
  useEffect(() => {
    if (selectedNodeId) {
      fetch(`/api/node-path/${encodeURIComponent(selectedNodeId)}`)
        .then(res => res.json())
        .then(data => {
          setSelectedNodePath(Array.isArray(data) ? data : []);
        })
        .catch(err => console.error("Failed to fetch node path", err));
    } else {
      setSelectedNodePath([]);
    }
  }, [selectedNodeId]);

  const fetchCoverageGridData = useCallback(async (start?: string, end?: string) => {
    let url = '/api/coverage/griddata';
    const params = [];
    if (start) params.push(`timeStart=${encodeURIComponent(start.replace('T', ' '))}`);
    if (end) params.push(`timeEnd=${encodeURIComponent(end.replace('T', ' '))}`);
    if (params.length > 0) {
      url += '?' + params.join('&');
    }
    try {
      const res = await fetch(url);
      const data = await res.json();
      setCoverageData(data);
    } catch (e) {
      console.error("Failed to fetch coverage grid data", e);
    }
  }, []);

  // 🚀 Fetch Chat Analytics
  useEffect(() => {
    if (showChatAnalytics && currentChatChannel) {
      fetch(`/api/chat-analytics/${encodeURIComponent(currentChatChannel)}`)
        .then(res => res.json())
        .then(data => setChatAnalyticsData(data))
        .catch(err => console.error("Failed to fetch chat analytics", err));
    }
  }, [showChatAnalytics, currentChatChannel]);

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

    // 🚀 WebSocket batch update buffers
    const pendingNodeUpdates = new Map();
    const pendingPackets = [];
    let pendingMqttConnected = null;

    // 🚀 WebSocket batch update flusher (runs every 1.5 seconds)
    const flushInterval = setInterval(() => {
      // 1. Flush Node Updates
      if (pendingNodeUpdates.size > 0) {
        const updatesArray = Array.from(pendingNodeUpdates.values());
        pendingNodeUpdates.clear();

        setNodes(prev => {
          const nodeMap = new Map(prev.map(n => [n.node_id, n]));
          updatesArray.forEach(updatedNode => {
            if (updatedNode.node_id) {
              if (nodeMap.has(updatedNode.node_id)) {
                nodeMap.set(updatedNode.node_id, { ...nodeMap.get(updatedNode.node_id), ...updatedNode });
              } else {
                nodeMap.set(updatedNode.node_id, updatedNode);
              }
            }
          });
          return Array.from(nodeMap.values());
        });
      }

      // 2. Flush Packet Logs & Coordinates
      if (pendingPackets.length > 0) {
        const packetsToProcess = [...pendingPackets];
        pendingPackets.length = 0; // Clear the array

        const now = new Date();
        const nowIso = now.toISOString();
        const datePart = `${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')}`;
        const timePart = now.toLocaleTimeString('zh-TW', { hour12: false });
        const nowTime = `${datePart} ${timePart}`;

        // 2a. Update coordinates in node state
        setNodes(prev => {
          let changed = false;
          const nodeMap = new Map(prev.map(n => [n.node_id, n]));
          packetsToProcess.forEach(packet => {
            const fromId = packet.from || packet.node_id;
            if (fromId && nodeMap.has(fromId)) {
              const existing = nodeMap.get(fromId);
              // Only update if coords actually changed
              const hasNewCoords = !packet.source && (packet.latitude !== undefined || packet.longitude !== undefined);
              if (hasNewCoords) {
                nodeMap.set(fromId, {
                  ...existing,
                  latitude: packet.latitude !== undefined && packet.latitude !== null ? packet.latitude : existing.latitude,
                  longitude: packet.longitude !== undefined && packet.longitude !== null ? packet.longitude : existing.longitude,
                  last_seen: nowIso
                });
                changed = true;
              }
            }
          });
          return changed ? Array.from(nodeMap.values()) : prev;
        });

        // 2b. Check if position packets exist to trigger coverage update
        const hasPosition = packetsToProcess.some(p => PORTNUM_NAMES[p.portnum] === 'POSITION' || p.portnum === 3 || p.portnum === '3');
        if (hasPosition) {
          fetch('/api/coverage/griddata').then(res => res.json()).then(setCoverageData).catch(() => {});
        }

        // 2c. Update packet stream
        const mqttPackets = packetsToProcess.filter(p => !p.source);
        if (mqttPackets.length > 0 && !filterActiveRef.current) {
          setPackets(prev => {
            const formatted = mqttPackets.map(packet => ({
              ...packet,
              from: packet.node_id || packet.from,
              timestamp: nowIso,
              time: nowTime,
              payload_json: packet.payload_json
                ? (typeof packet.payload_json === 'string' ? JSON.parse(packet.payload_json) : packet.payload_json)
                : null
            }));
            return [...formatted, ...prev].slice(0, 300);
          });
        }

        // 2d. Handle chat alerts & selected node packets list
        packetsToProcess.forEach(packet => {
          const fromId = packet.node_id || packet.from;
          const isText = (PORTNUM_NAMES[packet.portnum] === 'TEXT_MESSAGE' || packet.portnum === '1' || packet.portnum === 1);
          if (isText && packet.payload_json?.text && packet.payload_json?.channel_name) {
            const msgChan = packet.payload_json.channel_name;
            if (activeTabRef.current !== 'chat' || currentChatChannelRef.current !== msgChan) {
              setUnreadChannels(prev => ({ ...prev, [msgChan]: true }));
            }
          }
          if (selectedNodeIdRef.current && fromId === selectedNodeIdRef.current) {
            setNodePackets(prev => [{ ...packet, timestamp: nowIso, time: nowTime }, ...prev].slice(0, 20));
          }
        });
      }

      // 3. Flush MQTT Status
      if (pendingMqttConnected !== null) {
        setMqttConnected(pendingMqttConnected);
        pendingMqttConnected = null;
      }
    }, 1500);

    // 🚀 Register socket listeners that push to buffer queues
    socket.on('mqtt_status', (data) => {
      pendingMqttConnected = data.connected;
    });

    socket.on('node_seen', (updatedNode) => {
      if (updatedNode && updatedNode.node_id) {
        const existing = pendingNodeUpdates.get(updatedNode.node_id) || {};
        pendingNodeUpdates.set(updatedNode.node_id, { ...existing, ...updatedNode });
      }
    });

    socket.on('node_seen_batch', (updates) => {
      if (updates) {
        updates.forEach(updatedNode => {
          if (updatedNode && updatedNode.node_id) {
            const existing = pendingNodeUpdates.get(updatedNode.node_id) || {};
            pendingNodeUpdates.set(updatedNode.node_id, { ...existing, ...updatedNode });
          }
        });
      }
    });

    socket.on('raw_packet_batch', (packets) => {
      if (packets) {
        pendingPackets.push(...packets);
      }
    });

    socket.on('telemetry_update', (data) => {
      if (data && data.node_id) {
        const existing = pendingNodeUpdates.get(data.node_id) || {};
        pendingNodeUpdates.set(data.node_id, {
          ...existing,
          node_id: data.node_id,
          battery_level: data.battery_level !== undefined && data.battery_level !== null ? data.battery_level : existing.battery_level,
          voltage: data.voltage !== undefined && data.voltage !== null ? data.voltage : existing.voltage,
          current: data.current !== undefined && data.current !== null ? data.current : existing.current,
          snr: data.snr !== undefined && data.snr !== null ? data.snr : existing.snr,
          rssi: data.rssi !== undefined && data.rssi !== null ? data.rssi : existing.rssi,
          air_util_tx: data.air_util_tx !== undefined && data.air_util_tx !== null ? data.air_util_tx : existing.air_util_tx,
          channel_utilization: data.channel_utilization !== undefined && data.channel_utilization !== null ? data.channel_utilization : existing.channel_utilization,
          temperature: data.temperature !== undefined && data.temperature !== null ? data.temperature : existing.temperature,
          humidity: data.humidity !== undefined && data.humidity !== null ? data.humidity : existing.humidity
        });
      }
    });

    socket.on('telemetry_batch', (updates) => {
      if (updates) {
        updates.forEach(data => {
          if (data && data.node_id) {
            const existing = pendingNodeUpdates.get(data.node_id) || {};
            pendingNodeUpdates.set(data.node_id, {
              ...existing,
              node_id: data.node_id,
              battery_level: data.battery_level !== undefined && data.battery_level !== null ? data.battery_level : existing.battery_level,
              voltage: data.voltage !== undefined && data.voltage !== null ? data.voltage : existing.voltage,
              current: data.current !== undefined && data.current !== null ? data.current : existing.current,
              snr: data.snr !== undefined && data.snr !== null ? data.snr : existing.snr,
              rssi: data.rssi !== undefined && data.rssi !== null ? data.rssi : existing.rssi,
              air_util_tx: data.air_util_tx !== undefined && data.air_util_tx !== null ? data.air_util_tx : existing.air_util_tx,
              channel_utilization: data.channel_utilization !== undefined && data.channel_utilization !== null ? data.channel_utilization : existing.channel_utilization,
              temperature: data.temperature !== undefined && data.temperature !== null ? data.temperature : existing.temperature,
              humidity: data.humidity !== undefined && data.humidity !== null ? data.humidity : existing.humidity
            });
          }
        });
      }
    });

    // 抓取網格化聚合數據
    fetchCoverageGridData(coverageStartTime, coverageEndTime);

    // 抓取 Traceroute 數據（多路徑版）
    const fetchTraceroutePaths = () => fetch('/api/traceroute/paths')
      .then(res => res.json())
      .then(data => setTraceroutePaths(Array.isArray(data) ? data : []))
      .catch(() => {});
    // 同時保留 latest 以作 fallback
    const fetchTraceroute = () => fetch('/api/traceroute/latest').then(res => res.json()).then(setTraceroutePath);
    fetchTraceroutePaths();
    fetchTraceroute();

    const sysInterval = setInterval(refreshDashboardData, 30000);
    const coverageInterval = setInterval(() => {
      fetchCoverageGridData(coverageStartTime, coverageEndTime);
    }, 120000); // 每 2 分鐘更新一次地圖背景點位
    const tracerouteInterval = setInterval(fetchTraceroute, 60000);
    const traceroutePathsInterval = setInterval(fetchTraceroutePaths, 30000); // 每 30 秒更新多路徑

    return () => {
      clearInterval(flushInterval);
      clearInterval(sysInterval);
      clearInterval(coverageInterval);
      clearInterval(tracerouteInterval);
      clearInterval(traceroutePathsInterval);
      socket.off('mqtt_status');
      socket.off('node_seen');
      socket.off('node_seen_batch');
      socket.off('raw_packet_batch');
      socket.off('telemetry_update');
      socket.off('telemetry_batch');
    };
  }, [fetchGlobalPackets, fetchFavoritePackets, loadNetworkStats, refreshDashboardData, globalPacketsCurrentPage, globalFilter, favPacketsCurrentPage, favLogFilter]);

  useEffect(() => {
    fetchGlobalPackets(globalPacketsCurrentPage, globalFilter);
  }, [fetchGlobalPackets, globalPacketsCurrentPage, globalFilter]);

  useEffect(() => {
    if (selectedNodeId) {
      fetchNodeStats(selectedNodeId);
    }
  }, [selectedNodeId]);

  useEffect(() => {
    if (selectedNodeId) {
      fetchNodeSpecificPackets(selectedNodeId, nodePacketsCurrentPage, nodeLogFilter);
    }
  }, [selectedNodeId, nodePacketsCurrentPage, nodeLogFilter, fetchNodeSpecificPackets]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const favInterval = setInterval(() => fetchFavoritePackets(favPacketsCurrentPage, favLogFilter, nodes), 60000);
    return () => clearInterval(favInterval);
  }, [fetchFavoritePackets, favPacketsCurrentPage, favLogFilter, nodes]);

  const fetchFusionEdges = useCallback(async () => {
    try {
      const res = await fetch('/api/topology/fusion-edges');
      const data = await res.json();
      setFusionEdges(data);
    } catch (e) { console.error("Fusion edges load failed", e); }
  }, []);

  useEffect(() => {
    if (activeTab === 'map' || activeTab === 'topology') {
      fetchFusionEdges();
      const interval = setInterval(fetchFusionEdges, 2 * 60 * 1000); // 2 minutes
      return () => clearInterval(interval);
    }
  }, [activeTab, fetchFusionEdges]);

  // --- SNR 加權動態 Hop 覆蓋範圍模擬演算法 (Multi-Source Topology Fusion) ---
  const calculateWeightedReachability = useCallback(() => {
    if (!simState.sourceNodeId || activeTab !== 'map') {
      setSimResultMap(new Map());
      return;
    }

    const adj = new Map<string, { id: string, snr: number }[]>();

    // 將 fusionEdges 轉換為雙向圖以利涵蓋率模擬
    fusionEdges.forEach(edge => {
      if (!adj.has(edge.source_id)) adj.set(edge.source_id, []);
      adj.get(edge.source_id)!.push({ id: edge.target_id, snr: edge.snr });

      if (!adj.has(edge.target_id)) adj.set(edge.target_id, []);
      adj.get(edge.target_id)!.push({ id: edge.source_id, snr: edge.snr });
    });

    const result = new Map<string, { hop: number, pathSnr: number }>();
    const queue = [{ id: simState.sourceNodeId, hop: 0, pathSnr: Infinity }];
    result.set(simState.sourceNodeId, { hop: 0, pathSnr: Infinity });

    while (queue.length > 0) {
      const { id, hop, pathSnr } = queue.shift()!;

      const recorded = result.get(id);
      if (recorded && (recorded.hop < hop || (recorded.hop === hop && recorded.pathSnr > pathSnr))) {
        continue;
      }

      if (hop >= simState.maxHops) continue;

      const nextNodes = adj.get(id) || [];
      for (const next of nextNodes) {
        if (next.snr < simState.minSnr) continue;

        const nextHop = hop + 1;
        const nextPathSnr = Math.min(pathSnr, next.snr);

        const existing = result.get(next.id);
        if (!existing || nextHop < existing.hop || (nextHop === existing.hop && nextPathSnr > existing.pathSnr)) {
          result.set(next.id, { hop: nextHop, pathSnr: nextPathSnr });
          queue.push({ id: next.id, hop: nextHop, pathSnr: nextPathSnr });
        }
      }
    }
    setSimResultMap(result);
  }, [simState, fusionEdges, activeTab]);

  useEffect(() => {
    calculateWeightedReachability();
  }, [calculateWeightedReachability]);

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
    <ErrorBoundary title="全域網頁畫面異常 (Global Application Error)">
      <div className={`min-h-screen flex flex-col transition-colors duration-300 ${darkMode ? 'bg-slate-950 text-slate-100 dark' : 'bg-slate-50 text-slate-900'} font-sans text-${fontSize}`}>
      <datalist id="node-list">
        {nodes.map(n => (
          <option key={n.node_id} value={n.node_id}>{n.long_name || n.node_id} ({n.short_name || '?'})</option>
        ))}
      </datalist>
      {/* Top Navbar */}
      <nav className={`${darkMode ? 'bg-slate-900' : 'bg-[#1e293b]'} text-white px-3 sm:px-6 py-2.5 sm:py-3 flex justify-between items-center shadow-lg border-b ${darkMode ? 'border-slate-800' : 'border-slate-700'}`}>
        <div className="flex items-center gap-2 sm:gap-3">
          <Radio className={mqttConnected ? "text-cyan-400 animate-pulse" : "text-slate-500"} size={20} />
          <span className="text-xs sm:text-base md:text-lg font-black tracking-widest uppercase truncate max-w-[150px] sm:max-w-none">Meshtastic <span className="text-cyan-400">Radar</span></span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 md:gap-6 text-xs sm:text-sm">
          <button
            onClick={() => setShowAnnouncement(true)}
            className={`p-1.5 sm:p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-slate-800 text-cyan-400' : 'hover:bg-slate-700 text-cyan-300'}`}
            title="查看系統公告"
          >
            <Megaphone size={18} />
          </button>
          <button
            onClick={() => setDarkMode(!darkMode)}
            className={`p-1.5 sm:p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-slate-800 text-yellow-400' : 'hover:bg-slate-700 text-slate-300'}`}
            title={darkMode ? "切換亮色模式" : "切換暗色模式"}
          >
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <span className={`flex items-center gap-1.5 px-2.5 py-0.5 sm:px-3 sm:py-1 rounded-full border text-[9px] sm:text-[10px] font-bold ${mqttConnected ? 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10' : 'border-red-500/50 text-red-400 bg-red-500/10'}`}>
            <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${mqttConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
            {mqttConnected ? 'ONLINE' : 'OFFLINE'}
          </span>
          <select value={fontSize} onChange={(e) => setFontSize(e.target.value)} className={`bg-transparent border-none text-white text-[10px] sm:text-xs outline-none hidden sm:block`}>
            <option value="sm" className="bg-slate-800">小字體</option>
            <option value="base" className="bg-slate-800">中字體</option>
            <option value="lg" className="bg-slate-800">大字體</option>
          </select>
        </div>
      </nav>

      {/* Tabs Menu */}
      <div className={`border-b sticky top-0 z-50 shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="max-w-7xl mx-auto flex overflow-x-auto no-scrollbar whitespace-nowrap px-1 sm:px-4">
          <button
            onClick={() => setActiveTab('analytics')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'analytics' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <BarChart3 size={15} /> 全網分析
          </button>
          <button
            onClick={() => setActiveTab('favorites')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'favorites' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <Star size={15} /> 最愛節點
          </button>
          <button
            onClick={() => setActiveTab('nodes')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'nodes' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <List size={16} /> 節點清單
          </button>
          <button
            onClick={() => setActiveTab('details')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'details' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <Info size={15} /> 節點詳情
          </button>
          <button
            onClick={() => setActiveTab('map')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'map' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <MapIcon size={15} /> 地圖監控
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'logs' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <Database size={15} /> 封包觀察
          </button>
          <button
            onClick={() => setActiveTab('gateways')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all ${activeTab === 'gateways' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <Signal size={15} /> 閘道監控
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-3.5 sm:px-6 py-3 sm:py-4 text-[11px] sm:text-xs font-black uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 border-b-2 transition-all relative ${activeTab === 'chat' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50 dark:bg-cyan-500/10 dark:text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <MessageCircle size={15} /> 頻道對話
            {hasAnyUnreadChat && (
              <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white dark:border-slate-900 animate-pulse"></span>
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
            <ErrorBoundary title="切換分頁時發生組件異常 (Tab Execution Error)">
            {activeTab === 'analytics' && (
              <div className="max-w-7xl mx-auto p-6 space-y-6 text-sm">
                <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入分析數據...</div>}>
                  <NetworkAnalytics darkMode={darkMode} />
                </React.Suspense>
              </div>
            )}

            {activeTab === 'nodes' && (
              <div className="max-w-7xl mx-auto p-6 space-y-6 text-sm">
                <div className="flex flex-col lg:flex-row gap-4 mb-4">
                  <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                      type="text"
                      placeholder="快速搜尋節點 ID / 名稱..."
                      className={`w-full pl-10 pr-4 py-2 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 outline-none text-sm transition-colors ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
                      value={nodeListSearchQuery}
                      onChange={(e) => setNodeListSearchQuery(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={nodeFilter.role}
                      onChange={(e) => setNodeFilter({ ...nodeFilter, role: e.target.value })}
                      className={`px-3 py-2 rounded-lg border text-xs font-bold outline-none shadow-sm ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-600'}`}
                    >
                      <option value="ALL">👤 所有角色</option>
                      {uniqueRoles.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <select
                      value={nodeFilter.hardware}
                      onChange={(e) => setNodeFilter({ ...nodeFilter, hardware: e.target.value })}
                      className={`px-3 py-2 rounded-lg border text-xs font-bold outline-none shadow-sm ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-600'}`}
                    >
                      <option value="ALL">💻 所有硬體</option>
                      {uniqueHardware.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <select
                      value={nodeFilter.timePreset}
                      onChange={(e) => setNodeFilter({ ...nodeFilter, timePreset: e.target.value })}
                      className={`px-3 py-2 rounded-lg border text-xs font-bold outline-none shadow-sm ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-600'}`}
                    >
                      <option value="ALL">⏱️ 不限時間</option>
                      <option value="1h">1 小時內活躍</option>
                      <option value="6h">6 小時內活躍</option>
                      <option value="24h">24 小時內活躍</option>
                      <option value="7d">7 天內活躍</option>
                    </select>
                  </div>
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
                      {filteredNodes.map((node, idx) => (
                        <tr
                          key={node.node_id}
                          onClick={() => { setSelectedNodeId(node.node_id); setActiveTab('details'); }}
                          className={`cursor-pointer transition-colors group text-sm ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}
                        >
                          <td className="px-6 py-4 relative" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setGroupDropdownNodeId(groupDropdownNodeId === node.node_id ? null : node.node_id)}
                              className={`p-1.5 rounded-full transition-all ${node.is_favorite ? 'text-yellow-500 hover:bg-yellow-500/20' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-200'}`}
                            >
                              <Star fill={node.is_favorite ? "currentColor" : "none"} size={18} />
                            </button>
                            {groupDropdownNodeId === node.node_id && (
                              <div className={`absolute ${idx >= filteredNodes.length - 3 ? 'bottom-full mb-1' : 'top-full mt-1'} left-4 w-32 rounded-lg shadow-xl border z-50 overflow-hidden ${darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                                <div className="max-h-48 overflow-y-auto">
                                  {favConfig.groups.map(g => (
                                    <div key={g.id} onClick={(e) => { e.stopPropagation(); assignNodeToGroup(node.node_id, g.id); setGroupDropdownNodeId(null); }} className={`px-3 py-2 text-xs cursor-pointer flex items-center gap-2 transition-colors ${darkMode ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-50 text-slate-700'}`}>
                                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getColorMeta(g.color).bg }}></span>
                                      {g.name}
                                    </div>
                                  ))}
                                  <div onClick={(e) => { e.stopPropagation(); assignNodeToGroup(node.node_id, 'ungrouped'); setGroupDropdownNodeId(null); }} className={`px-3 py-2 text-xs cursor-pointer transition-colors border-t ${darkMode ? 'hover:bg-slate-700 text-slate-300 border-slate-700' : 'hover:bg-slate-50 text-slate-700 border-slate-100'}`}>
                                    未分組
                                  </div>
                                  {node.is_favorite ? (
                                    <div onClick={(e) => { e.stopPropagation(); toggleFavorite(node.node_id); setGroupDropdownNodeId(null); }} className={`px-3 py-2 text-xs cursor-pointer transition-colors border-t text-red-500 ${darkMode ? 'hover:bg-slate-700 border-slate-700' : 'hover:bg-slate-50 border-slate-100'}`}>
                                      ❌ 移除最愛
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 font-mono font-bold text-cyan-600 text-xs">
                            {node.node_id}
                          </td>
                            {(() => {
                              const roleStr = String(node.role || '');
                              const isRouter = roleStr.includes('ROUTER');
                              const isBase = roleStr.includes('BASE');
                              const isRepeater = roleStr.includes('REPEATER');
                              const isTracker = roleStr.includes('TRACKER');
                              return (
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                  isRouter ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' :
                                  isBase ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                                  isRepeater ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' :
                                  isTracker ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' :
                                  darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  {typeof node.role === 'string' ? node.role.replace('_', ' ') : String(node.role || 'CLIENT')}
                                </span>
                              );
                            })()}
                          <td className="px-6 py-4 text-xs">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-black truncate max-w-[120px] ${darkMode ? 'text-slate-100' : 'text-slate-900'}`}>{node.long_name || 'Unknown'}</span>
                              <span className="text-[10px] font-bold text-cyan-500 bg-cyan-500/10 px-1 rounded">({node.short_name || 'N/A'})</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-mono border uppercase tracking-tighter ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                              {typeof node.hw_model === 'string' ? node.hw_model.replace(/_/g, ' ') : String(node.hw_model || 'UNKNOWN')}
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
                        className={`px-4 py-2 rounded-t-lg text-[10px] font-black uppercase tracking-tighter transition-all whitespace-nowrap border-b-2 relative ${currentChatChannel === chan
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
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black transition-all border ${chatFilter.favoritesOnly
                        ? 'bg-yellow-500 border-yellow-400 text-white shadow-[0_0_8px_rgba(234,179,8,0.4)]'
                        : darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-white border-slate-200 text-slate-500'
                        }`}
                    >
                      <Star size={12} fill={chatFilter.favoritesOnly ? "currentColor" : "none"} /> 僅最愛
                    </button>
                    <button
                      onClick={() => setShowChatAnalytics(!showChatAnalytics)}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black transition-all border ${showChatAnalytics
                        ? 'bg-purple-600 border-purple-500 text-white shadow-[0_0_8px_rgba(147,51,234,0.4)]'
                        : darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-white border-slate-200 text-slate-500'
                        }`}
                    >
                      <BarChart3 size={12} /> 頻道分析
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

                {showChatAnalytics && chatAnalyticsData && (
                  <div className={`p-4 border-b shrink-0 flex gap-4 overflow-x-auto ${darkMode ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                    {/* Top Talkers */}
                    <div className={`flex-1 min-w-[300px] p-4 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                      <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2"><Activity size={14} /> Top Talkers (7 days)</h4>
                      <div className="space-y-2">
                        {chatAnalyticsData.topTalkers.map((t: any, idx: number) => {
                          const n = nodeMap.get(t.from_id);
                          const maxCount = chatAnalyticsData.topTalkers[0]?.message_count || 1;
                          const pct = (t.message_count / maxCount) * 100;
                          return (
                            <div key={idx} className="flex items-center gap-3 text-[11px]">
                              <div className="w-4 font-black text-slate-400 text-right">{idx + 1}.</div>
                              <div className="w-24 truncate font-bold text-cyan-600 cursor-pointer hover:underline" onClick={() => handleShowModal(t.from_id)}>
                                {n?.short_name || t.from_id}
                              </div>
                              <div className="flex-1 h-3 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full" style={{ width: `${pct}%` }}></div>
                              </div>
                              <div className="w-10 text-right font-black text-slate-500">{t.message_count}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* Word Cloud */}
                    <div className={`flex-1 min-w-[300px] p-4 rounded-xl border flex flex-col ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                      <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2"><MessageCircle size={14} /> Hot Words (7 days)</h4>
                      <div className="flex-1 flex flex-wrap content-start gap-2 overflow-y-auto pr-2 custom-scrollbar max-h-[160px]">
                        {chatAnalyticsData.wordCloud.map((w: any, idx: number) => {
                          const maxVal = chatAnalyticsData.wordCloud[0]?.value || 1;
                          const scale = 0.8 + (w.value / maxVal) * 1.5;
                          const opacity = 0.5 + (w.value / maxVal) * 0.5;
                          return (
                            <span key={idx} style={{ fontSize: `${scale}rem`, opacity }} className="font-black text-purple-500 inline-block leading-none">
                              {w.text}
                            </span>
                          );
                        })}
                        {chatAnalyticsData.wordCloud.length === 0 && <span className="text-slate-400 italic text-xs">No enough data</span>}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin">
                  {chatMessages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 italic">
                      <MessageCircle size={48} className="mb-4 opacity-10" />
                      <p>{(chatFilter.favoritesOnly || chatFilter.nodeId || chatFilter.searchText) ? "找不到符合條件的訊息" : "尚無文字訊息紀錄"}</p>
                    </div>
                  )}
                  {chatMessages.map((msg, idx) => {
                    const sender = nodeMap.get(msg.node_id);
                    const isFavorite = favoriteIdSet.has(msg.node_id);

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
                                  const rawTs = msg.timestamp ? String(msg.timestamp) : '';
                                  const dateStr = (typeof rawTs === 'string' && rawTs.includes(' ')) ? rawTs.replace(' ', 'T') + 'Z' : rawTs;
                                  return new Date(dateStr).toLocaleString('zh-TW', { hour12: false });
                                })()}
                              </span>
                              {isFavorite && <span className="text-[10px] font-bold text-yellow-500">YOU (FAV)</span>}
                            </div>
                            <div className={`px-4 py-2 rounded-2xl text-sm shadow-sm break-all ${isFavorite
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
              <div className="space-y-4">
                {/* ===== 頂部標題 + 工具列 ===== */}
                <div className={`flex flex-wrap justify-between items-center gap-3 pb-4 border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                  <h2 className="text-2xl font-bold flex items-center gap-2 text-yellow-500">
                    <Star size={28} fill="currentColor" /> 最愛節點監控面板
                    <span className="text-lg text-slate-500 font-mono">({favoriteIdSet.size})</span>
                  </h2>
                  <div className="flex items-center gap-2">
                    {/* 匯入 */}
                    <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer transition-all ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`} title="匯入 my_favorite.txt">
                      <span>📥 匯入</span>
                      <input type="file" accept=".txt,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importFavorites(f); e.target.value = ''; }} />
                    </label>
                    {/* 匯出 */}
                    <button onClick={exportFavorites} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`} title="匯出 my_favorite.txt">
                      📤 匯出
                    </button>
                    {/* 管理群組 */}
                    <button onClick={() => setIsGroupManagerOpen(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-500 transition-all">
                      ⚙️ 管理群組
                    </button>
                    <button onClick={() => { const favIds = Array.from(favoriteIdSet); fetchPackets('favorite', favPacketsCurrentPage, favLogFilter, undefined, favIds.length > 0 ? favIds : undefined); }} className={`p-2 rounded-full transition-colors ${darkMode ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`} title="重新整理">
                      <RefreshCw size={18} className={loadingPackets ? 'animate-spin' : ''} />
                    </button>
                  </div>
                </div>

                {/* ===== 群組分頁列 ===== */}
                <div className={`flex flex-wrap gap-1 p-1 rounded-xl ${darkMode ? 'bg-slate-800/50' : 'bg-slate-100'}`}>
                  {/* 全部 tab */}
                  <button
                    onClick={() => setActiveFavGroupId('all')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-black transition-all ${activeFavGroupId === 'all' ? 'bg-yellow-500 text-white shadow-md' : (darkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                  >
                    <Star size={11} fill={activeFavGroupId === 'all' ? 'currentColor' : 'none'} />
                    全部 ({favoriteIdSet.size})
                  </button>
                  {/* 各群組 tab */}
                  {favConfig.groups.map(g => {
                    const cm = getColorMeta(g.color);
                    const isActive = activeFavGroupId === g.id;
                    return (
                      <button
                        key={g.id}
                        onClick={() => setActiveFavGroupId(g.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-black transition-all ${isActive ? `${cm.bg} text-white shadow-md` : (darkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                      >
                        <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-white/70' : cm.bg}`}></span>
                        {g.name} ({g.nodeIds.length})
                      </button>
                    );
                  })}
                  {/* 未分組 tab */}
                  {favConfig.ungrouped.length > 0 && (
                    <button
                      onClick={() => setActiveFavGroupId('ungrouped')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-black transition-all ${activeFavGroupId === 'ungrouped' ? 'bg-slate-600 text-white shadow-md' : (darkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                      未分組 ({favConfig.ungrouped.length})
                    </button>
                  )}
                </div>

                {/* ===== 節點卡片網格 ===== */}
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
                      const idLen = node.node_id ? node.node_id.length : 0;
                      status = { color: 'text-slate-500', glow: '', border: 'border-slate-700', offline: true, msg: wittyMsgs[Math.floor(idLen % wittyMsgs.length)] };
                    }

                    const nodeGroupId = getNodeGroupId(node.node_id);
                    const nodeGroup = favConfig.groups.find(g => g.id === nodeGroupId);
                    const nodeCm = nodeGroup ? getColorMeta(nodeGroup.color) : null;
                    const isDropdownOpen = groupDropdownNodeId === node.node_id;

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
                            {/* 群組標籤 */}
                            {nodeGroup && (
                              <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black mb-1 ${nodeCm?.bg} text-white`}>
                                <span className="w-1.5 h-1.5 rounded-full bg-white/60"></span>
                                {nodeGroup.name}
                              </div>
                            )}
                            <div className="flex items-center gap-2 mb-1">
                              <span className="px-1.5 py-0.5 bg-yellow-500 text-white text-[9px] font-black rounded uppercase tracking-wider shadow-sm">{node.node_id}</span>
                              <span className={`text-[9px] font-mono border rounded px-1.5 py-0.5 uppercase tracking-tighter ${darkMode ? 'bg-slate-950 border-slate-700 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                                {typeof node.hw_model === 'string' ? node.hw_model.replace(/_/g, ' ') : String(node.hw_model || 'UNKNOWN')}
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

                          {/* 右上角：群組下拉 + 取消最愛 */}
                          <div className="flex flex-col items-end gap-1.5 ml-2" onClick={e => e.stopPropagation()}>
                            {/* 移至群組下拉 */}
                            <div className="relative">
                              <button
                                onClick={() => setGroupDropdownNodeId(isDropdownOpen ? null : node.node_id)}
                                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-all border ${darkMode ? 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300' : 'border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600'}`}
                                title="移至群組"
                              >
                                <span>{nodeGroup ? `🏷️ ${nodeGroup.name}` : '🏷️ 未分組'}</span>
                                <span className="opacity-60">▾</span>
                              </button>
                              {isDropdownOpen && (
                                <div className={`absolute right-0 top-full mt-1 w-44 rounded-xl shadow-2xl border z-50 overflow-hidden ${darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                                  <div className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest ${darkMode ? 'bg-slate-700/50 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>選擇群組</div>
                                  <button
                                    onClick={() => assignNodeToGroup(node.node_id, 'ungrouped')}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold text-left transition-colors ${nodeGroupId === 'ungrouped' ? (darkMode ? 'bg-slate-600' : 'bg-slate-100') : ''} ${darkMode ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-50 text-slate-600'}`}
                                  >
                                    <span className="w-2.5 h-2.5 rounded-full bg-slate-400 flex-shrink-0"></span>
                                    未分組
                                    {nodeGroupId === 'ungrouped' && <span className="ml-auto text-[10px] text-yellow-500">✓</span>}
                                  </button>
                                  {favConfig.groups.map(g => {
                                    const cm = getColorMeta(g.color);
                                    return (
                                      <button
                                        key={g.id}
                                        onClick={() => assignNodeToGroup(node.node_id, g.id)}
                                        className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold text-left transition-colors ${nodeGroupId === g.id ? (darkMode ? 'bg-slate-600' : 'bg-slate-100') : ''} ${darkMode ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-50 text-slate-600'}`}
                                      >
                                        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cm.bg}`}></span>
                                        {g.name}
                                        {nodeGroupId === g.id && <span className="ml-auto text-[10px] text-yellow-500">✓</span>}
                                      </button>
                                    );
                                  })}
                                  {favConfig.groups.length === 0 && (
                                    <div className="px-3 py-2 text-[10px] text-slate-500 italic">尚無群組，請先建立</div>
                                  )}
                                </div>
                              )}
                            </div>
                            {/* 移除最愛 */}
                            <button
                              onClick={() => toggleFavorite(node.node_id)}
                              className="text-yellow-500 p-1.5 hover:scale-110 transition-transform bg-yellow-500/10 rounded-full"
                              title="從最愛移除"
                            >
                              <Star fill="currentColor" size={20} />
                            </button>
                          </div>
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
                    );
                  }) : (
                    <div className="col-span-full py-20 text-center text-slate-400 italic">
                      {activeFavGroupId === 'all'
                        ? '尚無收藏節點。點擊節點清單中的星星圖示來加入收藏。'
                        : '此群組尚無節點。請在節點卡片的「移至群組」下拉選單中分配。'
                      }
                    </div>
                  )}
                </div>

                {/* ===== 地圖 ===== */}
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
                      selectedNodePath={selectedNodePath}
                      showTrackerHistory={showTrackerHistory}
                      showTraceroute={showTraceroute}
                      showHopGrid={showHopGrid}
                      simResultMap={simResultMap}
                      simState={simState}
                    />
                  </div>
                </div>

                {/* ===== 封包追蹤表格 ===== */}
                <div className="space-y-4 pt-4">
                  <div className={`rounded-xl shadow-sm border overflow-hidden text-sm ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <div className={`p-4 border-b flex justify-between items-center ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                      <h3 className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
                        <Database size={16} className="text-cyan-500" /> 成員通訊追蹤
                      </h3>
                    </div>
                    {renderFilterBar(favLogFilter, setFavLogFilter)}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[11px] font-mono border-collapse">
                        <thead className={`${darkMode ? 'bg-slate-800/30 text-slate-400' : 'bg-slate-100 text-slate-500'} border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                          <tr>
                            <th className="p-3">時間</th>
                            <th className="p-3">發送者</th>
                            <th className="p-3">種類</th>
                            <th className="p-3">Gateway (最後轉傳)</th>
                            <th className="p-3 text-center">SNR/RSSI</th>
                            <th className="p-3 text-right">詳情</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`} >
                          {favoritePackets.map((p, i) => {
                            const senderNode = nodeMap.get(p.from);
                            const gwNode = nodeMap.get(p.gateway_id!);
                            return (
                              <tr key={i} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}>
                                <td className="p-3 text-slate-400">{p.time}</td>
                                <td className="p-3">
                                  <button onClick={() => handleShowModal(p.from)} className="text-yellow-500 font-bold hover:underline text-left">
                                    {p.from} ({senderNode?.short_name || '??'})
                                  </button>
                                </td>
                                <td className="p-3">
                                  <span className={`px-1.5 py-0.5 rounded border font-bold text-[9px] ${p.portnum === 'ENCRYPTED' ? (darkMode ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-red-50 border-red-100 text-red-600') : (darkMode ? 'bg-slate-800 border-slate-700 text-cyan-400' : 'bg-blue-50 border-blue-100 text-blue-600')}`}>
                                    {p.portnum === 'ENCRYPTED' ? 'PRIVATE' : (PORTNUM_NAMES[p.portnum] || p.portnum)}
                                  </span>
                                </td>
                                <td className="p-3">
                                  <button onClick={() => p.gateway_id && handleShowModal(p.gateway_id)} className={`font-bold hover:underline ${darkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                                    {p.gateway_id || 'Unknown'} {gwNode ? `(${gwNode.short_name})` : ''}
                                  </button>
                                </td>
                                <td className="p-3 text-center text-slate-500">{p.snr ?? '-'}/{p.rssi ?? '-'}</td>
                                <td className="p-3 text-right">
                                  <button onClick={() => openPacketDetail(p)} className="p-1.5 hover:bg-blue-100 text-blue-500 rounded-md transition-colors"><Eye size={14} /></button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {favoritePackets.length === 0 && (
                        <div className="p-10 text-center text-slate-400 italic text-sm">{loadingPackets ? "載入中..." : "無符合條件的成員封包"}</div>
                      )}
                    </div>
                    <div className={`p-4 border-t flex justify-end items-center gap-4 ${darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                      <span className="text-xs text-slate-500">總計 {favPacketsTotalCount} 筆</span>
                      <button onClick={() => setFavPacketsCurrentPage(prev => Math.max(1, prev - 1))} disabled={favPacketsCurrentPage === 1 || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold disabled:opacity-50 ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'}`}>上一頁</button>
                      <span className="text-xs font-bold text-slate-400">{favPacketsCurrentPage} / {Math.ceil(favPacketsTotalCount / packetsPerPage) || 1}</span>
                      <button onClick={() => setFavPacketsCurrentPage(prev => prev + 1)} disabled={favPacketsCurrentPage * packetsPerPage >= favPacketsTotalCount || loadingPackets} className={`px-3 py-1 rounded text-xs font-bold disabled:opacity-50 ${darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'}`}>下一頁</button>
                    </div>
                  </div>
                </div>

                {/* ===== 群組管理 Modal ===== */}
                {isGroupManagerOpen && (
                  <div className="fixed inset-0 z-[4000] flex items-center justify-center p-6">
                    <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setIsGroupManagerOpen(false)}></div>
                    <div className={`relative w-full max-w-lg rounded-2xl shadow-2xl border flex flex-col max-h-[85vh] ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                      {/* Modal 標題 */}
                      <div className="p-5 border-b flex justify-between items-center bg-gradient-to-r from-yellow-600 to-orange-600 rounded-t-2xl">
                        <h3 className="text-white font-black text-base flex items-center gap-2">⚙️ 群組管理</h3>
                        <button onClick={() => setIsGroupManagerOpen(false)} className="text-white/80 hover:text-white hover:rotate-90 transition-all"><X size={20} /></button>
                      </div>

                      <div className="overflow-y-auto flex-1 p-5 space-y-4">
                        {/* 新增群組 */}
                        <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                          <h4 className={`text-[10px] font-black uppercase tracking-widest mb-3 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>➕ 新增群組</h4>
                          <div className="flex gap-2 mb-3">
                            <input
                              type="text"
                              placeholder="群組名稱（如：台北站）"
                              value={newGroupName}
                              onChange={e => setNewGroupName(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && addGroup(newGroupName, newGroupColor)}
                              className={`flex-1 px-3 py-2 rounded-lg border text-sm outline-none ${darkMode ? 'bg-slate-700 border-slate-600 text-slate-200 placeholder-slate-500' : 'bg-white border-slate-300 text-slate-700'}`}
                            />
                          </div>
                          {/* 顏色選擇 */}
                          <div className="flex flex-wrap gap-2 mb-3">
                            {GROUP_COLORS.map(c => (
                              <button
                                key={c.key}
                                onClick={() => setNewGroupColor(c.key)}
                                title={c.label}
                                className={`w-7 h-7 rounded-full ${c.bg} transition-all ${newGroupColor === c.key ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900 scale-110' : 'opacity-60 hover:opacity-100'}`}
                              />
                            ))}
                          </div>
                          <button
                            onClick={() => addGroup(newGroupName, newGroupColor)}
                            disabled={!newGroupName.trim()}
                            className="w-full py-2 bg-yellow-500 hover:bg-yellow-400 text-white font-black rounded-lg text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            建立群組
                          </button>
                        </div>

                        {/* 現有群組列表 */}
                        <div>
                          <h4 className={`text-[10px] font-black uppercase tracking-widest mb-2 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>現有群組</h4>
                          {favConfig.groups.length === 0 ? (
                            <div className={`p-6 rounded-xl text-center text-sm italic ${darkMode ? 'text-slate-600' : 'text-slate-400'}`}>尚無群組</div>
                          ) : (
                            <div className="space-y-2">
                              {favConfig.groups.map(g => {
                                const cm = getColorMeta(g.color);
                                return (
                                  <div key={g.id} className={`flex items-center gap-3 p-3 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-white border-slate-200'}`}>
                                    <span className={`w-4 h-4 rounded-full flex-shrink-0 ${cm.bg}`}></span>
                                    {editingGroupId === g.id ? (
                                      <input
                                        autoFocus
                                        type="text"
                                        value={editingGroupName}
                                        onChange={e => setEditingGroupName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') renameGroup(g.id, editingGroupName); if (e.key === 'Escape') setEditingGroupId(null); }}
                                        onBlur={() => renameGroup(g.id, editingGroupName)}
                                        className={`flex-1 px-2 py-1 rounded border text-sm outline-none ${darkMode ? 'bg-slate-700 border-slate-600 text-slate-200' : 'bg-white border-slate-300 text-slate-700'}`}
                                      />
                                    ) : (
                                      <div className="flex-1">
                                        <span className={`text-sm font-bold ${darkMode ? 'text-slate-200' : 'text-slate-700'}`}>{g.name}</span>
                                        <span className="ml-2 text-[10px] text-slate-500">{g.nodeIds.length} 個節點</span>
                                      </div>
                                    )}
                                    {/* 重命名 */}
                                    <button
                                      onClick={() => { setEditingGroupId(g.id); setEditingGroupName(g.name); }}
                                      className={`p-1.5 rounded-lg text-[11px] transition-colors ${darkMode ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                                      title="重命名"
                                    >✏️</button>
                                    {/* 刪除 */}
                                    <button
                                      onClick={() => { if (window.confirm(`確定刪除「${g.name}」群組？群組內的節點將移到未分組。`)) deleteGroup(g.id); }}
                                      className={`p-1.5 rounded-lg text-[11px] transition-colors ${darkMode ? 'hover:bg-red-500/20 text-slate-500 hover:text-red-400' : 'hover:bg-red-50 text-slate-400 hover:text-red-500'}`}
                                      title="刪除群組"
                                    >🗑️</button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* 匯出/匯入區 */}
                        <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                          <h4 className={`text-[10px] font-black uppercase tracking-widest mb-3 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>💾 備份與還原</h4>
                          <div className="flex gap-2">
                            <button onClick={exportFavorites} className="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-lg text-sm transition-all">
                              📤 匯出 my_favorite.txt
                            </button>
                            <label className="flex-1 py-2 bg-slate-600 hover:bg-slate-500 text-white font-bold rounded-lg text-sm transition-all cursor-pointer text-center">
                              📥 匯入
                              <input type="file" accept=".txt,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) { importFavorites(f); setIsGroupManagerOpen(false); } e.target.value = ''; }} />
                            </label>
                          </div>
                          <p className={`text-[10px] mt-2 ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                            匯出的 my_favorite.txt 包含所有群組與節點設定，可跨設備或在清除快取後還原。
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
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
                        <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入遙測圖表...</div>}>
                          <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} node={selectedNode} darkMode={darkMode} />
                        </React.Suspense>
                      </section>

                      <section>
                        <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入健康診斷...</div>}>
                          <RfHealthChart nodeId={selectedNode.node_id} darkMode={darkMode} />
                        </React.Suspense>
                      </section>

                      {/* 📱 尋找失聯節點 QR Code 產生器 */}
                      <section>
                        <NodeRecoveryQR nodeId={selectedNode.node_id} longName={selectedNode.long_name} shortName={selectedNode.short_name} darkMode={darkMode} />
                      </section>

                      <section>
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                          <MapIcon size={14} /> 節點位置
                        </h4>
                        <div className="h-[512px] rounded-xl overflow-hidden border border-slate-200">
                          {selectedNode.latitude || gatewayStats.length > 0 ? (
                            <React.Suspense fallback={<div className="h-full flex items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-400 font-mono">地圖載入中...</div>}>
                              <NodeMap
                                nodes={[selectedNode]}
                                allNodes={nodes}
                                gateways={gatewayStats}
                                activeTab={activeTab}
                                isDetailView={true}
                                onSelectNode={() => { }}
                                coverageData={coverageData}
                                selectedNodePath={selectedNodePath}
                                showTrackerHistory={true}
                                showTraceroute={showTraceroute}
                                showHopGrid={showHopGrid}
                              />
                            </React.Suspense>
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
                                const gwNode = nodeMap.get(g.gateway_id);
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
                                <th className="p-3">Gateway (最後轉傳)</th>
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
                                        onClick={() => openPacketDetail(p)}
                                        className="p-1.5 hover:bg-blue-100 text-blue-500 rounded-md transition-colors"
                                      >
                                        <Eye size={14} />
                                      </button>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                          {filteredNodePackets.length === 0 && <div className="p-10 text-center text-slate-300 italic">無符合過濾條件之紀錄</div>}
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

            {activeTab === 'topology' && (
              <div className="w-full h-[75vh]">
                <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入拓撲圖...</div>}>
                  <TopologyGraph nodes={nodes} edges={fusionEdges} darkMode={darkMode} />
                </React.Suspense>
              </div>
            )}

            {activeTab === 'map' && (
              <div className="space-y-6">
                {showSimulator && (
                  <div className={`rounded-xl border shadow-sm p-4 ${darkMode ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-white border-slate-200'}`}>
                    <div className="flex flex-wrap items-center gap-6">
                      <div className="flex items-center gap-2">
                        <Signal size={16} className="text-cyan-500" />
                        <span className="text-sm font-black uppercase tracking-widest text-cyan-500">動態覆蓋模擬器</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="text-xs font-bold text-slate-500">發射源:</label>
                        <input
                          list="sim-nodes-list"
                          placeholder="搜尋或選擇節點"
                          value={simSearchText}
                          onChange={e => {
                            const val = e.target.value;
                            setSimSearchText(val);
                            const match = val.match(/\((![a-fA-F0-9]+)\)/);
                            if (match) {
                              setSimState(s => ({ ...s, sourceNodeId: match[1] }));
                            } else {
                              if (val.startsWith('!') && val.length > 5) {
                                setSimState(s => ({ ...s, sourceNodeId: val }));
                              } else {
                                setSimState(s => ({ ...s, sourceNodeId: '' }));
                              }
                            }
                          }}
                          className={`text-xs p-1.5 rounded border outline-none w-[180px] ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                        />
                        <datalist id="sim-nodes-list">
                          {nodes.filter(n => n.latitude && n.longitude).map(n => (
                            <option key={n.node_id} value={`${n.long_name || n.node_id} (${n.node_id})`} />
                          ))}
                        </datalist>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="text-xs font-bold text-slate-500">最大跳數 (Hops): {simState.maxHops}</label>
                        <input
                          type="range" min="1" max="7"
                          value={simState.maxHops}
                          onChange={e => setSimState(s => ({ ...s, maxHops: parseInt(e.target.value) }))}
                          className="w-24 accent-cyan-500"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="text-xs font-bold text-slate-500">SNR 門檻: {simState.minSnr}</label>
                        <input
                          type="range" min="-25" max="10"
                          value={simState.minSnr}
                          onChange={e => setSimState(s => ({ ...s, minSnr: parseInt(e.target.value) }))}
                          className="w-24 accent-cyan-500"
                        />
                      </div>

                      <button
                        onClick={() => { setSimState({ sourceNodeId: '', maxHops: 3, minSnr: -20 }); setSimSearchText(''); }}
                        className={`ml-auto px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-widest transition-colors ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-500'}`}
                      >
                        清除模擬
                      </button>
                    </div>
                  </div>
                )}

                <div className={`rounded-xl border shadow-sm ${darkMode ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-white border-slate-200'}`}>
                  <div className="p-4 flex flex-wrap justify-between items-center gap-4">
                    <div className="flex gap-4 items-center">
                      <button
                        onClick={() => setShowNodes(!showNodes)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showNodes ? 'bg-blue-500 border-blue-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <MapPin size={12} /> 節點地圖
                      </button>
                      <button
                        onClick={() => setShowTraceroute(!showTraceroute)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showTraceroute ? 'bg-amber-500 border-amber-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <Zap size={12} /> 覆蓋範圍
                      </button>
                      <button
                        onClick={() => setShowHopGrid(!showHopGrid)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showHopGrid ? 'bg-green-600 border-green-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <TrendingDown size={12} /> 跳轉分析
                      </button>
                      <button
                        onClick={() => setShowTrackerHistory(!showTrackerHistory)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showTrackerHistory ? 'bg-pink-600 border-pink-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <Activity size={12} /> 歷史軌跡
                      </button>
                      <button
                        onClick={() => setShowLogicGraph(!showLogicGraph)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black border transition-all ${showLogicGraph ? 'bg-purple-600 border-purple-500 text-white shadow-lg shadow-purple-500/20' : 'bg-slate-800 border-slate-700 text-slate-500'}`}
                      >
                        <Share2 size={12} /> 拓撲邏輯連線
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="relative flex items-center">
                        <Search className="absolute left-2.5 text-slate-500 pointer-events-none" size={12} />
                        <input
                          type="text"
                          placeholder="搜尋地圖上的節點..."
                          value={mapSearchText}
                          onChange={(e) => {
                            setMapSearchText(e.target.value);
                            if (!e.target.value) {
                              setMapCenterCoords(undefined);
                            }
                          }}
                          className={`pl-8 pr-6 py-1.5 rounded-lg border text-[10px] outline-none w-44 transition-all focus:ring-1 focus:ring-cyan-500 ${
                            darkMode 
                              ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' 
                              : 'bg-white border-slate-200 text-slate-700 placeholder-slate-400'
                          }`}
                        />
                        {mapSearchText && (
                          <button 
                            onClick={() => { setMapSearchText(''); setMapCenterCoords(undefined); }}
                            className="absolute right-2 text-slate-400 hover:text-slate-200 text-[10px]"
                          >
                            ✕
                          </button>
                        )}
                        
                        {mapSearchText && (() => {
                          const searchLower = mapSearchText.toLowerCase();
                          const matched = nodes
                            .filter(n => n.latitude && n.longitude)
                            .filter(n => 
                              n.node_id.toLowerCase().includes(searchLower) ||
                              (n.long_name || '').toLowerCase().includes(searchLower) ||
                              (n.short_name || '').toLowerCase().includes(searchLower)
                            )
                            .slice(0, 5);
                          
                          if (matched.length === 0) return null;
                          return (
                            <div className={`absolute top-full left-0 right-0 mt-1 rounded-lg border shadow-xl z-[3000] overflow-hidden max-h-48 overflow-y-auto ${
                              darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
                            }`}>
                              {matched.map(n => (
                                <button
                                  key={n.node_id}
                                  onClick={() => {
                                    setMapCenterCoords([n.latitude!, n.longitude!]);
                                    setMapSearchText(`${n.long_name || n.short_name || n.node_id} (${n.node_id})`);
                                  }}
                                  className={`w-full text-left px-3 py-2 text-[10px] font-bold transition-colors border-b last:border-0 ${
                                    darkMode 
                                      ? 'hover:bg-slate-700 text-slate-200 border-slate-700/50' 
                                      : 'hover:bg-slate-100 text-slate-700 border-slate-100'
                                  }`}
                                >
                                  <div className="truncate font-black">{n.long_name || 'Unknown'} ({n.short_name || '??'})</div>
                                  <div className="text-[8px] text-slate-500 font-mono">{n.node_id} | {n.role || 'CLIENT'}</div>
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>

                      <div className={`flex items-center rounded-lg p-1 gap-2 ${darkMode ? 'bg-slate-800' : 'bg-slate-100'}`}>
                        <button
                          onClick={() => setMapShowFavoritesOnly(false)}
                          className={`px-4 py-1.5 text-xs font-black uppercase tracking-widest rounded-md transition-all ${!mapShowFavoritesOnly ? 'bg-cyan-500 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                          顯示全部
                        </button>
                        <div className="relative flex items-center">
                          <select
                            value={mapShowFavoritesOnly ? mapFavoriteGroup : 'none'}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === 'none') {
                                setMapShowFavoritesOnly(false);
                              } else {
                                setMapShowFavoritesOnly(true);
                                setMapFavoriteGroup(val);
                              }
                            }}
                            className={`px-3 py-1.5 text-xs font-black uppercase tracking-widest rounded-md border-none outline-none cursor-pointer transition-all ${
                              mapShowFavoritesOnly 
                                ? 'bg-cyan-500 text-white shadow-md' 
                                : darkMode ? 'bg-slate-800 text-slate-400 hover:text-slate-200' : 'bg-slate-100 text-slate-500 hover:text-slate-700'
                            }`}
                          >
                            <option value="none" className={darkMode ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-700'}>
                              最愛節點 (關閉)
                            </option>
                            <option value="all" className={darkMode ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-700'}>
                              ⭐ 顯示所有最愛
                            </option>
                            {favConfig.groups.map(g => (
                              <option key={g.id} value={g.id} className={darkMode ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-700'}>
                                🏷️ 最愛: {g.name}
                              </option>
                            ))}
                            {favConfig.ungrouped.length > 0 && (
                              <option value="ungrouped" className={darkMode ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-700'}>
                                📁 最愛: 未分組
                              </option>
                            )}
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {(showTraceroute || showHopGrid) && (
                  <div className={`p-3 rounded-xl border flex flex-wrap items-center gap-3 text-xs mb-3 ${darkMode ? 'bg-slate-900/50 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="font-black text-[10px] uppercase tracking-wider text-cyan-500 flex items-center gap-1">
                      📅 訊號覆蓋日期範圍篩選:
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="datetime-local"
                        value={coverageStartTime}
                        onChange={(e) => setCoverageStartTime(e.target.value)}
                        className={`px-2 py-1 rounded text-[10px] outline-none border ${
                          darkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      />
                      <span>~</span>
                      <input
                        type="datetime-local"
                        value={coverageEndTime}
                        onChange={(e) => setCoverageEndTime(e.target.value)}
                        className={`px-2 py-1 rounded text-[10px] outline-none border ${
                          darkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      />
                      <button
                        onClick={() => fetchCoverageGridData(coverageStartTime, coverageEndTime)}
                        className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] font-black rounded transition-colors"
                      >
                        應用篩選
                      </button>
                      <button
                        onClick={() => {
                          setCoverageStartTime('');
                          setCoverageEndTime('');
                          fetchCoverageGridData('', '');
                        }}
                        className={`px-2 py-1 text-[10px] font-black rounded transition-colors ${
                          darkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                        }`}
                      >
                        重置
                      </button>
                    </div>
                  </div>
                )}

                <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                  Map Visualization: {mapNodes.length} Nodes
                </div>

                <div className={`w-full rounded-2xl overflow-hidden border shadow-sm relative transition-all duration-300 ${
                  isMapFullScreen 
                    ? 'fixed inset-0 z-[2000] h-screen w-screen rounded-none' 
                    : 'h-[70vh]'
                } ${darkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'}`}>
                  <button
                    onClick={() => setIsMapFullScreen(!isMapFullScreen)}
                    className={`absolute top-4 right-4 z-[1000] p-2.5 rounded-xl shadow-lg border transition-all duration-200 hover:scale-105 ${
                      darkMode 
                        ? 'bg-slate-900/90 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800' 
                        : 'bg-white/90 border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                    }`}
                    title={isMapFullScreen ? "退出全螢幕" : "全螢幕模式"}
                  >
                    {isMapFullScreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>

                   <React.Suspense fallback={<div className="h-full flex items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-400 font-mono">地圖載入中...</div>}>
                    <NodeMap
                      nodes={mapNodes}
                      allNodes={nodes}
                      onSelectNode={handleShowModal}
                      activeTab={activeTab}
                      onShowDetail={handleShowModal}
                      showNodes={showNodes}
                      showUtilization={showUtilization}
                      showTraceroute={showTraceroute}
                      showHopGrid={showHopGrid}
                      traceroutePath={traceroutePath}
                      neighbors={neighbors}
                      coverageData={coverageData}
                      selectedNodePath={selectedNodePath}
                      showTrackerHistory={showTrackerHistory}
                      showSimulator={showSimulator}
                      simResultMap={simResultMap}
                      simState={simState}
                      showLogicGraph={showLogicGraph}
                      fusionEdges={fusionEdges}
                      traceroutePaths={traceroutePaths}
                      isMapFullScreen={isMapFullScreen}
                      mapCenter={mapCenterCoords}
                    />
                  </React.Suspense>
                </div>

                {showLogicGraph && (
                  <div className={`mt-6 w-full h-[75vh] rounded-2xl overflow-hidden border shadow-sm relative transition-colors ${darkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'}`}>
                    <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入拓撲圖...</div>}>
                      <TopologyGraph nodes={nodes} edges={fusionEdges} darkMode={darkMode} />
                    </React.Suspense>
                  </div>
                )}
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
                      <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入遙測圖表...</div>}>
                        <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} node={selectedNode} darkMode={darkMode} />
                      </React.Suspense>
                    </section>

                    <section>
                      <React.Suspense fallback={<div className="p-8 text-center text-slate-500 font-mono">正在載入健康診斷...</div>}>
                        <RfHealthChart nodeId={selectedNode.node_id} darkMode={darkMode} />
                      </React.Suspense>
                    </section>

                    {/* 📱 尋找失聯節點 QR Code 產生器 */}
                    <section>
                      <NodeRecoveryQR nodeId={selectedNode.node_id} longName={selectedNode.long_name} shortName={selectedNode.short_name} darkMode={darkMode} />
                    </section>

                    <section>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                        <MapIcon size={14} /> 節點位置
                      </h4>
                      <div className="h-[400px] rounded-xl overflow-hidden border border-slate-200">
                        {selectedNode.latitude || gatewayStats.length > 0 ? (
                          <React.Suspense fallback={<div className="h-full flex items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-400 font-mono">地圖載入中...</div>}>
                            <NodeMap
                              nodes={[selectedNode]}
                              allNodes={nodes}
                              gateways={gatewayStats}
                              activeTab={activeTab}
                              isDetailView={true}
                              onSelectNode={() => { }}
                              coverageData={coverageData}
                              selectedNodePath={selectedNodePath}
                              showTrackerHistory={true}
                              showTraceroute={showTraceroute}
                              showHopGrid={showHopGrid}
                            />
                          </React.Suspense>
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
                              const gwNode = nodeMap.get(g.gateway_id);
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
                              )
                            })}
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
                                      <span className="text-red-500 font-bold flex items-center gap-1"><ZapOff size={12} /> 私有加密封包</span>
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
                                    <button onClick={() => openPacketDetail(p)} className="text-blue-500 hover:underline text-[10px] font-bold">查看內容</button>
                                  </td>
                                </tr>
                              )
                            })}
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
            )}            {activeTab === 'logs' && (
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
                          <th className="p-3">Gateway (最後轉傳)</th>
                          <th className="p-3 text-center">SNR/RSSI</th>
                          <th className="p-3 text-right">詳情</th>
                        </tr>
                      </thead>
                      <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                        {filteredGlobalPackets.map((p, i) => {
                          const senderNode = nodeMap.get(p.from);
                          const gwNode = nodeMap.get(p.gateway_id);
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
                                  onClick={() => openPacketDetail(p)}
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
                      <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1"><Search size={10} /> 搜尋 ID</label>
                      <input
                        type="text" placeholder="搜尋閘道器..." value={gatewayFilter.search}
                        onChange={(e) => setGatewayFilter({ ...gatewayFilter, search: e.target.value })}
                        className={`w-full p-1.5 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1"><Database size={10} /> 最少封包</label>
                      <input
                        type="number" value={gatewayFilter.minPackets}
                        onChange={(e) => setGatewayFilter({ ...gatewayFilter, minPackets: e.target.value === '' ? '' : Number(e.target.value) })}
                        className={`w-full p-1.5 rounded border text-[10px] outline-none ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200'}`}
                      />
                    </div>
                    <div className="flex gap-2 items-end">
                      <div className="space-y-1 flex-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase flex items-center gap-1"><Signal size={10} /> 最低 SNR</label>
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

                  <div className={`mt-6 w-full h-80 border-b relative ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <NodeMap
                      nodes={[]}
                      allNodes={nodes}
                      gateways={filteredGateways}
                      onSelectNode={handleShowModal}
                      showNodes={false}
                      activeTab={activeTab}
                    />
                  </div>

                  <table className="w-full text-left">
                    <thead className={`${darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'} text-[10px] font-black uppercase tracking-widest`}>
                      <tr>
                        <th className="px-6 py-4">排名</th>
                        <th className="px-6 py-4">閘道器 ID</th>
                        <th className="px-6 py-4 text-center">總處理封包</th>
                        <th className="px-6 py-4 text-center">平均 SNR</th>
                        <th className="px-6 py-4">最後活動</th>
                        <th className="px-6 py-4 text-center">操作</th>
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
                          <td className="px-6 py-4 text-center">
                            <button
                              onClick={() => {
                                setGlobalFilter(prev => ({ ...prev, gateway: gw.gateway_id }));
                                setActiveTab('logs');
                              }}
                              className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-colors border ${darkMode ? 'bg-slate-800 border-slate-700 hover:bg-cyan-900/30 text-cyan-400 border-cyan-900/50' : 'bg-slate-50 border-slate-200 hover:bg-cyan-50 text-cyan-600 border-cyan-200'}`}
                            >
                              檢視封包
                            </button>
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
                <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => { setSelectedPacket(null); setSelectedPacketDetail(null); setSelectedPacketGateways([]); }}></div>
                <div className={`relative w-full max-w-2xl rounded-2xl shadow-2xl border overflow-hidden flex flex-col max-h-[80vh] ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="p-4 bg-blue-600 text-white flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Cpu size={18} />
                      <span className="font-black uppercase tracking-widest text-xs">Packet Payload Decoder</span>
                      {loadingPacketDetail && (
                        <span className="text-[10px] text-blue-200 animate-pulse ml-1">Loading detail...</span>
                      )}
                    </div>
                    <button onClick={() => { setSelectedPacket(null); setSelectedPacketDetail(null); setSelectedPacketGateways([]); }} className="hover:rotate-90 transition-transform"><X size={20} /></button>
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

                    {/* 📡 收到該封包的 Gateway 地圖視覺化 */}
                    {(() => {
                      const gwNode = nodes.find(n => n.node_id === selectedPacket.gateway_id);
                      const senderNode = nodes.find(n => n.node_id === selectedPacket.from);
                      const gwLat = gwNode?.latitude;
                      const gwLng = gwNode?.longitude;
                      const senderLat = senderNode?.latitude;
                      const senderLng = senderNode?.longitude;

                      const hasGwGps = gwLat && gwLng;
                      const hasSenderGps = senderLat && senderLng;

                      if (!hasGwGps && !hasSenderGps) return null;

                      const mapCenter: [number, number] = hasGwGps ? [gwLat, gwLng] : [senderLat!, senderLng!];
                      return (
                        <div className="space-y-2">
                          <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider block">
                            收發地理路徑 Map (Gateway: {selectedPacket.gateway_id || 'Unknown'})
                          </span>
                          <div className="h-44 rounded-xl overflow-hidden border border-slate-300 dark:border-slate-700">
                            <MapContainer 
                              key={`pkt-map-${selectedPacket.id || selectedPacket.timestamp}`}
                              center={mapCenter} 
                              zoom={11} 
                              style={{ height: '100%', width: '100%' }} 
                              zoomControl={false}
                            >
                              <TileLayer 
                                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" 
                              />
                              {hasGwGps && (
                                <CircleMarker 
                                  center={[gwLat, gwLng]} 
                                  radius={6} 
                                  pathOptions={{ fillColor: '#ef4444', color: 'white', weight: 1.5, fillOpacity: 0.9 }}
                                >
                                  <Popup>
                                    <div className="text-[10px] font-sans">
                                      接收閘道器 Gateway: <strong>{gwNode.short_name || gwNode.node_id}</strong>
                                    </div>
                                  </Popup>
                                </CircleMarker>
                              )}
                              {hasSenderGps && (
                                <CircleMarker 
                                  center={[senderLat, senderLng]} 
                                  radius={6} 
                                  pathOptions={{ fillColor: '#3b82f6', color: 'white', weight: 1.5, fillOpacity: 0.9 }}
                                >
                                  <Popup>
                                    <div className="text-[10px] font-sans">
                                      發送節點 Sender: <strong>{senderNode.short_name || senderNode.node_id}</strong>
                                    </div>
                                  </Popup>
                                </CircleMarker>
                              )}
                              {hasGwGps && hasSenderGps && (
                                <Polyline 
                                  positions={[[senderLat, senderLng], [gwLat, gwLng]]} 
                                  color="#10b981" 
                                  weight={2} 
                                  dashArray="4, 4"
                                />
                              )}
                            </MapContainer>
                          </div>
                        </div>
                      );
                    })()}

                    {/* 🚀 使用懶加載的 detail 資料渲染視覺化 */}
                    {selectedPacketDetail && renderPacketVisualizer({ ...selectedPacket, payload_json: selectedPacketDetail.payload_json, rawData: selectedPacketDetail.rawData })}

                    {/* 📡 所有收到該封包的 Gateway 列表 */}
                    <div>
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block flex items-center gap-1">
                        <Signal size={12} className="text-cyan-500" /> 收到此封包的閘道器 (Received Gateways)
                        {loadingPacketGateways && <span className="text-[9px] text-cyan-400 animate-pulse ml-1">載入中...</span>}
                      </span>
                      {selectedPacketGateways.length > 0 ? (
                        <div className={`rounded-xl overflow-hidden border ${darkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                          <table className="w-full text-[10px] font-mono">
                            <thead className={`${darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                              <tr>
                                <th className="p-2 text-left font-black uppercase">Gateway ID</th>
                                <th className="p-2 text-left font-black uppercase">名稱</th>
                                <th className="p-2 text-center font-black uppercase">SNR</th>
                                <th className="p-2 text-center font-black uppercase">RSSI</th>
                                <th className="p-2 text-center font-black uppercase">跳數</th>
                                <th className="p-2 text-right font-black uppercase">收到時間</th>
                              </tr>
                            </thead>
                            <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                              {selectedPacketGateways.map((gw, i) => {
                                const gwNode = nodes.find(n => n.node_id === gw.gateway_id);
                                const isCurrent = gw.gateway_id === selectedPacket.gateway_id;
                                return (
                                  <tr key={i} className={`${isCurrent ? (darkMode ? 'bg-cyan-900/30' : 'bg-cyan-50') : ''}`}>
                                    <td className="p-2">
                                      <button
                                        onClick={() => {
                                          setSelectedPacket(null);
                                          setSelectedPacketDetail(null);
                                          setSelectedPacketGateways([]);
                                          handleShowModal(gw.gateway_id);
                                        }}
                                        className={`font-bold hover:underline text-left ${
                                          isCurrent
                                            ? 'text-cyan-400'
                                            : darkMode
                                            ? 'text-blue-400 hover:text-blue-300'
                                            : 'text-blue-600 hover:text-blue-800'
                                        }`}
                                        title="查看此 Gateway 的節點詳情"
                                      >
                                        {gw.gateway_id}{isCurrent && <span className="ml-1 text-[8px] text-cyan-500">(此筆)</span>}
                                      </button>
                                    </td>
                                    <td className="p-2 text-slate-400">{gwNode?.long_name || gwNode?.short_name || '--'}</td>
                                    <td className="p-2 text-center">
                                      <span className={gw.snr >= 0 ? 'text-green-400' : gw.snr >= -10 ? 'text-yellow-400' : 'text-red-400'}>
                                        {gw.snr?.toFixed(2) ?? '--'} dB
                                      </span>
                                    </td>
                                    <td className="p-2 text-center text-slate-400">{gw.rssi ?? '--'} dBm</td>
                                    <td className="p-2 text-center text-slate-400">{gw.hops_away ?? '--'}</td>
                                    <td className="p-2 text-right text-slate-500">
                                      {gw.timestamp ? new Date(gw.timestamp.includes(' ') ? gw.timestamp.replace(' ', 'T') + 'Z' : gw.timestamp).toLocaleTimeString('zh-TW', { hour12: false }) : '--'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        !loadingPacketGateways && (
                          <div className={`p-3 rounded-xl text-center text-[10px] italic ${darkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-50 text-slate-400'}`}>
                            僅由單一 Gateway 收到，或無閘道器資訊
                          </div>
                        )
                      )}
                    </div>

                    <div>
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">Decoded JSON Data</span>
                      <div className={`p-4 rounded-xl font-mono text-xs overflow-x-auto ${darkMode ? 'bg-black text-emerald-400' : 'bg-slate-900 text-slate-200'}`}>
                        {loadingPacketDetail ? (
                          <div className="py-4 text-center text-slate-500 italic animate-pulse">⏳ 載入封包詳情中...</div>
                        ) : selectedPacketDetail?.payload_json ? (
                          <pre>{JSON.stringify(selectedPacketDetail.payload_json, null, 2)}</pre>
                        ) : (
                          <div className="py-4 text-center text-slate-600 italic">
                            此封包為加密內容或無可解析負載 (Encrypted/No Payload)
                          </div>
                        )}
                      </div>
                    </div>

                    {selectedPacketDetail?.rawData && (
                      <div>
                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">Raw Payload (Hex / 原始數據)</span>
                        <div className="p-3 bg-slate-100 rounded-lg font-mono text-[9px] text-slate-500 break-all border border-slate-200">
                          {selectedPacketDetail.rawData}
                        </div>
                      </div>
                    )}

                  </div>{/* end p-6 overflow-y-auto */}

                  <div className={`p-4 border-t text-[10px] text-center font-bold tracking-widest ${darkMode ? 'border-slate-800 text-slate-600' : 'border-slate-100 text-slate-400'}`}>
                    NODE_ID: {selectedPacket.from} | GW: {selectedPacket.gateway_id}
                  </div>
                </div>
              </div>
            )}



          </ErrorBoundary>
          </main>

          <footer className={`mt-auto p-4 border-t text-[10px] font-bold ${darkMode ? 'bg-slate-900/50 border-slate-800 text-slate-500' : 'bg-white border-slate-100 text-slate-400'}`}>
            <div className="max-w-7xl mx-auto flex flex-wrap justify-between items-center gap-4">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-1.5"><Cpu size={12} className="text-cyan-500" /> 系統負載: {sysStatus?.cpu_load?.[0]?.toFixed(2) || '--'}</div>
                <div className="flex items-center gap-1.5"><Database size={12} className="text-purple-500" /> 程序記憶體: {sysStatus?.memory ? (sysStatus.memory.rss / 1024 / 1024).toFixed(1) : '--'} MB</div>
                <div className="flex items-center gap-1.5"><HardDrive size={12} className="text-emerald-500" /> 資料庫大小: {sysStatus?.db_size ? (sysStatus.db_size / 1024 / 1024).toFixed(2) : '--'} MB</div>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-1.5 uppercase tracking-widest">
                  <Activity size={12} className="text-orange-500" />
                  連續運行時間: {displayedUptime != null ? `${Math.floor(displayedUptime / 3600)}h ${Math.floor((displayedUptime % 3600) / 60)}m ${Math.floor(displayedUptime % 60)}s` : '--'}
                </div>
                <div className="hidden sm:block opacity-30 tracking-[0.2em]">MESHTASTIC RADAR ENGINE v2.2</div>
              </div>
            </div>
          </footer>
        </div>
      )}
      {showAnnouncement && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowAnnouncement(false)}></div>
          <div className={`relative w-full max-w-lg rounded-2xl shadow-2xl border p-6 flex flex-col gap-4 ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
              <h2 className="text-lg font-black text-cyan-500 flex items-center gap-2">
                <Megaphone size={24} /> {ANNOUNCEMENT_TITLE}
              </h2>
              <button onClick={() => setShowAnnouncement(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className={`whitespace-pre-wrap text-sm leading-relaxed max-h-[60vh] overflow-y-auto pr-2 scrollbar-thin ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>
              {ANNOUNCEMENT_TEXT}
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-slate-200 dark:border-slate-800 mt-2">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-slate-400 text-cyan-500 focus:ring-cyan-500"
                  checked={hideAnnouncementNextTime}
                  onChange={(e) => {
                    setHideAnnouncementNextTime(e.target.checked);
                    if (e.target.checked) {
                      localStorage.setItem('hideAnnouncement_v2_2', 'true');
                    } else {
                      localStorage.removeItem('hideAnnouncement_v2_2');
                    }
                  }}
                />
                <span className={`text-xs font-bold transition-colors ${darkMode ? 'text-slate-400 group-hover:text-slate-200' : 'text-slate-500 group-hover:text-slate-700'}`}>不再顯示此公告</span>
              </label>

              <button
                onClick={() => setShowAnnouncement(false)}
                className={`px-5 py-2 rounded-lg font-bold text-sm transition-colors ${darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  </ErrorBoundary>
);
}

export default App;