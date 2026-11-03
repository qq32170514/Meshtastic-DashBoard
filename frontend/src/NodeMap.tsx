import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, Polyline, Tooltip, useMap, Rectangle, GeoJSON, Circle, ImageOverlay } from 'react-leaflet';
import * as turf from '@turf/turf';
import L from 'leaflet';
import { Node } from './App';
import { Info, ChevronDown, ChevronUp, BarChart2, Radio, Activity, Wifi } from 'lucide-react';
import { AppTileLayer, MapStyleSelector, getDefaultTileStyle } from './mapTiles';

// Traceroute 多路徑型別
export interface TracerouteHop {
  nodeId: string;
  name: string;
  latitude: number;
  longitude: number;
  snr: number | null;
}
export interface TraceroutePath {
  id: string;
  timestamp: string;
  hops: TracerouteHop[];
  totalHops: number;
}

// 修正 Leaflet 預設圖示路徑問題
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import MarkerClusterGroup from 'react-leaflet-cluster';
const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

// 顏色映射函數：根據 Role 返回對應顏色
const getRoleColor = (role?: any) => {
  const roleStr = String(role || '').toUpperCase();
  switch (roleStr) {
    case 'ROUTER': return '#dc2626';        // 紅色 (基礎設施)
    case 'ROUTER_CLIENT': return '#ea580c'; // 橘色
    case 'TRACKER': return '#16a34a';       // 綠色 (追蹤器)
    case 'MESSENGER': return '#eab308';     // 黃色
    case 'REPEATER': return '#9333ea';      // 紫色
    case 'CLIENT':
    default: return '#2563eb';              // 藍色 (一般用戶)
  }
};

// 根據活躍時間獲取濾鏡效果：越久沒出現，顏色越暗且越灰
/**
 * 能量等級 (Energy Level) 視覺化
 * 越新鮮的節點：越亮 (Brightness)、越飽和 (Saturation)、且尺寸越大 (Scale)
 */
const getRecencyVisuals = (lastSeen?: string) => {
  if (!lastSeen) return { filter: 'grayscale(1) brightness(0.4)' };
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffHours = diffMs / 3600000;
  const diffMinutes = diffMs / 60000;

  if (diffMinutes < 5) return { filter: 'brightness(1.3) saturate(2)' };
  if (diffHours < 2) return { filter: 'brightness(1.1) saturate(1.4)' };
  if (diffHours < 12) return { filter: 'brightness(0.8) saturate(0.7)' };
  if (diffHours < 24) return { filter: 'brightness(0.6) saturate(0.3)' };
  return { filter: 'grayscale(1) brightness(0.4)' };
};

// 🚀 建立自定義彩色圖標快取池 (避免每次重新渲染建立數百個重複的 L.divIcon 實例)
const iconCache = new Map<string, L.DivIcon>();

const getRecencyBucket = (lastSeen?: string): string => {
  if (!lastSeen) return 'bOld';
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffMinutes = diffMs / 60000;
  const diffHours = diffMs / 3600000;
  if (diffMinutes < 5) return 'b5m';
  if (diffHours < 2) return 'b2h';
  if (diffHours < 12) return 'b12h';
  if (diffHours < 24) return 'b24h';
  return 'bOld';
};

const createColoredIcon = (role?: string, lastSeen?: string) => {
  const roleKey = String(role || '').toUpperCase();
  const recencyKey = getRecencyBucket(lastSeen);
  const cacheKey = `${roleKey}_${recencyKey}`;

  const cached = iconCache.get(cacheKey);
  if (cached) return cached;

  const color = getRoleColor(role);
  const { filter } = getRecencyVisuals(lastSeen);
  const baseShadow = 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))';

  const icon = L.divIcon({
    html: `
      <svg width="25" height="41" viewBox="0 0 25 41" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: ${baseShadow} ${filter}; transition: filter 0.5s ease;">
        <path d="M12.5 0C5.596 0 0 5.596 0 12.5C0 21.875 12.5 41 12.5 41C12.5 41 25 21.875 25 12.5C25 5.596 19.404 0 12.5 0Z" fill="${color}" stroke="white" stroke-width="1.5"/>
        <circle cx="12.5" cy="12.5" r="4.5" fill="white" />
      </svg>
    `,
    className: '',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });

  iconCache.set(cacheKey, icon);
  return icon;
};

// 顏色映射函數：活躍時間越近，顏色越深
const getRecencyColor = (lastSeen?: string) => {
  if (!lastSeen) return '#cbd5e1';
  const diffHours = (Date.now() - new Date(lastSeen).getTime()) / 3600000;
  if (diffHours < 2) return '#1e3a8a';   // 2小時內 - 深藍
  if (diffHours < 6) return '#3b82f6';   // 2~6小時 - 鮮藍
  if (diffHours < 12) return '#60a5fa';  // 6~12小時 - 天藍
  if (diffHours < 24) return '#93c5fd';  // 12~24小時 - 淺藍
  return '#cbd5e1';                      // 24小時以上 - 灰色
};

interface NodeMapProps {
  nodes: Node[];
  allNodes?: Node[];      // 新增：所有節點資料，用於查找 Gateway 座標
  gateways?: any[];       // 新增：目前節點關聯的閘道統計
  onSelectNode: (id: string) => void;
  onShowDetail?: (id: string) => void; // 新增：顯示漂浮詳情頁的回呼
  isDetailView?: boolean; // 新增：是否為節點詳情模式
  showUtilization?: boolean; // 新增：顯示利用率圖層
  showNodes?: boolean;     // 新增：顯示節點標記
  neighbors?: any[];       // 新增：鄰居關係資料
  activeTab?: string;
  showTraceroute?: boolean;
  showHopGrid?: boolean;
  coverageData?: any[];
  traceroutePath?: any[];
  selectedNodePath?: any[];
  showTrackerHistory?: boolean;
  simResultMap?: Map<string, { hop: number, pathSnr: number }>;
  simState?: { sourceNodeId: string, maxHops: number, minSnr: number };
  showSimulator?: boolean;
  showLogicGraph?: boolean;
  showItmCoverage?: boolean;
  setShowItmCoverage?: React.Dispatch<React.SetStateAction<boolean>> | ((val: boolean | ((prev: boolean) => boolean)) => void);
  itmMeta?: any;
  fusionEdges?: any[];
  traceroutePaths?: TraceroutePath[];
  isMapFullScreen?: boolean;
  mapCenter?: [number, number];
  darkMode?: boolean;
}

const getHopColor = (hops: number) => {
  const h = hops || 0;
  if (h <= 0) return "#22c55e"; // 0 跳: 綠色 (直接接收)
  if (h === 1) return "#84cc16"; // 1 跳: 萊姆綠
  if (h === 2) return "#eab308"; // 2 跳: 黃色
  if (h === 3) return "#f59e0b"; // 3 跳: 琥珀色
  if (h === 4) return "#f97316"; // 4 跳: 橘色
  if (h === 5) return "#ea580c"; // 5 跳: 深橘色
  return "#ef4444";             // 5+ 跳: 紅色
};

const NodeMap = ({
  nodes,
  allNodes = [],
  gateways = [],
  onSelectNode,
  onShowDetail,
  isDetailView = false,
  showNodes = true,
  showUtilization = false,
  showTraceroute = false,
  traceroutePath = [],
  neighbors = [],
  showHopGrid = false,
  coverageData = [],
  selectedNodePath = [],
  showTrackerHistory = false,
  showSimulator = false,
  simResultMap,
  simState,
  activeTab,
  showLogicGraph = false,
  showItmCoverage: externalShowItmCoverage,
  setShowItmCoverage: externalSetShowItmCoverage,
  itmMeta: externalItmMeta,
  fusionEdges = [],
  traceroutePaths = [],
  isMapFullScreen = false,
  mapCenter,
  darkMode = true
}: NodeMapProps) => {
  const [tileStyle, setTileStyle] = useState<string>(() => getDefaultTileStyle(darkMode));
  const [isLegendExpanded, setIsLegendExpanded] = useState(false);
  const [mapColorMode, setMapColorMode] = useState<'role' | 'cu'>('role');
  const [selectedGwId, setSelectedGwId] = useState<string | null>(null);
  const [relayedNodesData, setRelayedNodesData] = useState<{
    gatewayId: string;
    relayedCount: number;
    totalPackets: number;
    relayedNodes: any[];
  } | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  // 📡 全台 3D 地形電波覆蓋 (Longley-Rice ITM) 預先烘焙圖層狀態
  const [internalShowItmCoverage, setInternalShowItmCoverage] = useState<boolean>(false);
  const showItmCoverage = externalShowItmCoverage !== undefined ? externalShowItmCoverage : internalShowItmCoverage;
  const setShowItmCoverage = externalSetShowItmCoverage || setInternalShowItmCoverage;
  const [internalItmMeta, setInternalItmMeta] = useState<any | null>(null);
  const itmMeta = externalItmMeta !== undefined ? externalItmMeta : internalItmMeta;

  useEffect(() => {
    if (externalItmMeta !== undefined) return;
    fetch('/api/coverage/itm-info')
      .then(res => res.json())
      .then(data => {
        if (data && data.available !== false) setInternalItmMeta(data);
      })
      .catch(() => {});
  }, [externalItmMeta]);

  // 📊 遙測封包接收成功率 (PRR) 圖層狀態
  const [showReceptionRate, setShowReceptionRate] = useState<boolean>(false);
  const [receptionRange, setReceptionRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [receptionData, setReceptionData] = useState<any | null>(null);
  const [receptionOverview, setReceptionOverview] = useState<any | null>(null);
  const [isLoadingReception, setIsLoadingReception] = useState<boolean>(false);

  const fetchReceptionRate = useCallback(async (type: 'node' | 'gateway' | 'overview', id?: string, range: string = '24h') => {
    setIsLoadingReception(true);
    try {
      let url = `/api/analytics/reception-rate?range=${range}`;
      if (type === 'node' && id) url += `&node_id=${encodeURIComponent(id)}`;
      if (type === 'gateway' && id) url += `&gateway_id=${encodeURIComponent(id)}`;

      const res = await fetch(url);
      const data = await res.json();
      if (type === 'overview') {
        setReceptionOverview(data);
      } else {
        setReceptionData(data);
      }
    } catch (err) {
      console.error('Fetch reception rate error:', err);
    } finally {
      setIsLoadingReception(false);
    }
  }, []);

  const currentDetailNodeId = (isDetailView && nodes.length > 0 && nodes[0]?.node_id) ? nodes[0].node_id : null;

  // 當時窗切換時，自動重新抓取目前視角資料
  useEffect(() => {
    if (!showReceptionRate) return;
    if (receptionData?.target_type === 'node' && receptionData.node?.node_id) {
      fetchReceptionRate('node', receptionData.node.node_id, receptionRange);
    } else if (receptionData?.target_type === 'gateway' && receptionData.gateway?.node_id) {
      fetchReceptionRate('gateway', receptionData.gateway.node_id, receptionRange);
    } else if (currentDetailNodeId) {
      fetchReceptionRate('node', currentDetailNodeId, receptionRange);
    } else {
      fetchReceptionRate('overview', undefined, receptionRange);
    }
  }, [receptionRange]);

  // 當詳情節點切換時，若 PRR 開啟中，自動同步載入新節點的 PRR 資料
  useEffect(() => {
    if (showReceptionRate && currentDetailNodeId) {
      setSelectedGwId(null);
      fetchReceptionRate('node', currentDetailNodeId, receptionRange);
    }
  }, [currentDetailNodeId, showReceptionRate]);

  // 監聽外部或跨元件底圖切換事件
  useEffect(() => {
    const handleTileChange = (e: any) => {
      if (e.detail) setTileStyle(e.detail);
    };
    window.addEventListener('meshtastic-map-tile-change', handleTileChange);
    return () => window.removeEventListener('meshtastic-map-tile-change', handleTileChange);
  }, []);

  // 🚀 解決重疊 Cluster 自動收回與 Popup 自動關閉的狀態管理器 (整合防抖鎖定機制與 DOM 狀態防護)
  const [localNodes, setLocalNodes] = useState(nodes);
  const [isLocked, setIsLocked] = useState(false);
  const unlockTimeoutRef = useRef<any>(null);

  const lock = useCallback(() => {
    setIsLocked(true);
    if (unlockTimeoutRef.current) {
      clearTimeout(unlockTimeoutRef.current);
    }
  }, []);

  const scheduleUnlock = useCallback(() => {
    if (unlockTimeoutRef.current) {
      clearTimeout(unlockTimeoutRef.current);
    }
    unlockTimeoutRef.current = setTimeout(() => {
      // 只有在「滑鼠不在地圖上」、「沒有彈窗打開」且「沒有展開的 spiderfy 蜘蛛腿」時，才解除鎖定更新
      const container = document.querySelector('.leaflet-container');
      const currentlyHovered = container ? container.matches(':hover') : false;
      const popupOpen = document.querySelector('.leaflet-popup');
      const hasSpiderlegs = !!document.querySelector('.leaflet-spiderleg-line') || !!document.querySelector('.marker-cluster-spiderfied');

      if (!currentlyHovered && !popupOpen && !hasSpiderlegs) {
        setIsLocked(false);
      }
    }, 8000); // 延長至 8 秒防鎖釋放
  }, []);

  // 當外部 nodes 變更時，若沒有鎖定且 DOM 顯示無互動干擾，則同步到本地狀態
  useEffect(() => {
    // 雙重保險：直接從 DOM 讀取真實狀態，確保 100% 避開事件觸發延遲或丟失的 Bug
    const container = document.querySelector('.leaflet-container');
    const currentlyHovered = container ? container.matches(':hover') : false;
    const popupOpen = document.querySelector('.leaflet-popup');
    const hasSpiderlegs = !!document.querySelector('.leaflet-spiderleg-line') || !!document.querySelector('.marker-cluster-spiderfied');

    if (!isLocked && !currentlyHovered && !popupOpen && !hasSpiderlegs) {
      setLocalNodes(nodes);
    }
  }, [nodes, isLocked]);

  // 當分頁切換時，強行重置解鎖狀態，以確保更新同步
  useEffect(() => {
    setIsLocked(false);
    if (unlockTimeoutRef.current) {
      clearTimeout(unlockTimeoutRef.current);
    }
  }, [activeTab]);

  const MapEventListener = () => {
    const map = useMap();
    useEffect(() => {
      const handleLock = () => {
        lock();
      };
      
      const handleUnlock = () => {
        scheduleUnlock();
      };

      // 監聽所有使用者互動與地圖動畫，啟動暫停鎖定
      map.on('zoomstart', handleLock);
      map.on('movestart', handleLock);
      map.on('mouseover', handleLock);
      map.on('popupopen', handleLock);
      map.on('dragstart', handleLock);
      map.on('click', handleLock);
      map.on('mousedown', handleLock);

      // 當互動結束或游標離開時，排程解除鎖定
      map.on('zoomend', handleUnlock);
      map.on('moveend', handleUnlock);
      map.on('mouseout', handleUnlock);
      map.on('popupclose', handleUnlock);
      map.on('dragend', handleUnlock);

      // 初始化檢查：如果滑鼠已經在地圖內，直接鎖定
      if (map.getContainer().matches(':hover')) {
        lock();
      }

      return () => {
        map.off('zoomstart', handleLock);
        map.off('movestart', handleLock);
        map.off('mouseover', handleLock);
        map.off('popupopen', handleLock);
        map.off('dragstart', handleLock);
        map.off('click', handleLock);
        map.off('mousedown', handleLock);

        map.off('zoomend', handleUnlock);
        map.off('moveend', handleUnlock);
        map.off('mouseout', handleUnlock);
        map.off('popupclose', handleUnlock);
        map.off('dragend', handleUnlock);
      };
    }, [map]);
    return null;
  };

  const nodesWithGPS = useMemo(() => {
    const withGPS = localNodes.filter(n => n.latitude && n.longitude);
    const CELL_SIZE = 0.00015;
    const grid = new Map<string, { node: Node; index: number }[]>();

    // 🚀 O(N) 將座標映射至二維空間網格，避免 O(N^2) 巢狀迴圈
    withGPS.forEach((node, index) => {
      const cellX = Math.floor(node.latitude! / CELL_SIZE);
      const cellY = Math.floor(node.longitude! / CELL_SIZE);
      const key = `${cellX}_${cellY}`;
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push({ node, index });
      } else {
        grid.set(key, [{ node, index }]);
      }
    });

    const jittered: Node[] = [];
    const processedIndices = new Set<number>();

    for (let i = 0; i < withGPS.length; i++) {
      if (processedIndices.has(i)) continue;

      const nodeI = withGPS[i];
      const cellX = Math.floor(nodeI.latitude! / CELL_SIZE);
      const cellY = Math.floor(nodeI.longitude! / CELL_SIZE);
      const group: { node: Node; index: number }[] = [];

      // 🚀 只檢索相鄰 3x3 空間網格 (O(1) 區域檢索)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighborBucket = grid.get(`${cellX + dx}_${cellY + dy}`);
          if (!neighborBucket) continue;
          for (const item of neighborBucket) {
            if (processedIndices.has(item.index)) continue;
            const diffLat = nodeI.latitude! - item.node.latitude!;
            const diffLng = nodeI.longitude! - item.node.longitude!;
            if (Math.sqrt(diffLat * diffLat + diffLng * diffLng) < CELL_SIZE) {
              group.push(item);
            }
          }
        }
      }

      group.forEach(item => processedIndices.add(item.index));

      if (group.length <= 1) {
        jittered.push(nodeI);
      } else {
        const count = group.length;
        const radius = 0.00015;
        group.forEach((item, idx) => {
          const angle = (idx * 2 * Math.PI) / count;
          const offsetLat = Math.sin(angle) * radius;
          const offsetLng = Math.cos(angle) * radius;
          jittered.push({
            ...item.node,
            latitude: item.node.latitude! + offsetLat,
            longitude: item.node.longitude! + offsetLng
          });
        });
      }
    }

    return jittered;
  }, [localNodes]);

  const nodeMarkers = useMemo(() => {
    return nodesWithGPS.map(node => {
      // 計算 Channel 顯示名稱（與原邏輯相同）
      const rawChannel = node.channel || '';
      const isInvalid = /^\d+$/.test(rawChannel) || ['c', 'json', 'e', 'stat', ''].includes(rawChannel);
      const channelName = isInvalid ? (() => {
        const parts = (node.last_topic || '').split('/');
        return parts.find((p: string) => !/^\d+$/.test(p) && !['msh', 'TW', 'c', 'json', 'e', 'stat', ''].includes(p) && !p.startsWith('!')) || '-';
      })() : rawChannel;
      const channelDisplay = channelName === 'MediumFast' ? '⚡ MediumFast' : channelName;

      // 計算最後活躍時間顯示
      const getLastSeenText = (lastSeen?: string) => {
        if (!lastSeen) return '從未';
        const diffMs = Date.now() - new Date(lastSeen).getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 60) return `${diffMin} 分鐘前`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr} 小時前`;
        return `${Math.floor(diffHr / 24)} 天前`;
      };

      return (
        <Marker
          key={node.node_id}
          icon={createColoredIcon(node.role, node.last_seen)}
          position={[node.latitude!, node.longitude!]}
          eventHandlers={{
            click: () => {
              onSelectNode(node.node_id);
              if (showReceptionRate) {
                fetchReceptionRate('node', node.node_id, receptionRange);
              }
            }
          }}
        >
          {/* Hover 顯示簡易節點圖卡 Tooltip */}
          <Tooltip
            direction="top"
            offset={[0, -38]}
            opacity={1}
            className="node-hover-tooltip"
          >
            <div style={{
              fontFamily: 'sans-serif',
              minWidth: '170px',
              maxWidth: '240px',
              padding: '0',
              borderRadius: '10px',
              overflow: 'hidden',
            }}>
              {/* 頭部：Long Name + Role badge */}
              <div style={{
                background: `${getRoleColor(node.role)}22`,
                borderBottom: `2px solid ${getRoleColor(node.role)}55`,
                padding: '7px 10px 5px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
              }}>
                <div style={{ fontWeight: 900, fontSize: '12px', color: '#1e293b', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.long_name || 'Unknown'}
                </div>
                <div style={{
                  background: getRoleColor(node.role),
                  color: 'white',
                  fontSize: '8px',
                  fontWeight: 900,
                  padding: '2px 5px',
                  borderRadius: '999px',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}>
                  {node.role || 'CLIENT'}
                </div>
              </div>

              {/* 主體：節點資訊列表 */}
              <div style={{ padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: '4px', background: 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
                  <span style={{ color: '#94a3b8', fontWeight: 700 }}>Short</span>
                  <span style={{ color: '#334155', fontWeight: 900 }}>{node.short_name || '??'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
                  <span style={{ color: '#94a3b8', fontWeight: 700 }}>ID</span>
                  <span style={{ color: '#2563eb', fontWeight: 900, fontFamily: 'monospace', fontSize: '9px' }}>{node.node_id}</span>
                </div>
                {channelDisplay !== '-' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
                    <span style={{ color: '#94a3b8', fontWeight: 700 }}>Channel</span>
                    <span style={{ color: '#0891b2', fontWeight: 900 }}>{channelDisplay}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
                  <span style={{ color: '#94a3b8', fontWeight: 700 }}>最後活躍</span>
                  <span style={{ color: '#475569', fontWeight: 700 }}>{getLastSeenText(node.last_seen)}</span>
                </div>
                {node.snr !== undefined && node.snr !== null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
                    <span style={{ color: '#94a3b8', fontWeight: 700 }}>SNR</span>
                    <span style={{ color: node.snr > 5 ? '#16a34a' : node.snr > -5 ? '#d97706' : '#dc2626', fontWeight: 900 }}>{node.snr} dB</span>
                  </div>
                )}
              </div>

              {/* 底部：點擊提示 */}
              <div style={{
                padding: '4px 10px',
                background: '#f8fafc',
                borderTop: '1px solid #e2e8f0',
                fontSize: '9px',
                color: '#94a3b8',
                fontWeight: 700,
                textAlign: 'center',
                letterSpacing: '0.05em'
              }}>
                點擊查看節點詳情
              </div>
            </div>
          </Tooltip>
        </Marker>
      );
    });
  }, [nodesWithGPS, onSelectNode]);

  const getCuColor = (cu?: number | null) => {
    if (cu === null || cu === undefined || isNaN(cu)) return '#94a3b8';
    if (cu >= 25) return '#ef4444'; // 🚨 危險
    if (cu >= 20) return '#f97316'; // ⚠️ 壅塞
    if (cu >= 5) return '#22c55e';  // 🟢 普通
    return '#3b82f6';               // 🔵 低度使用
  };

  const handleGatewayClick = async (gwId: string) => {
    if (selectedGwId === gwId) {
      setSelectedGwId(null);
      setRelayedNodesData(null);
      if (showReceptionRate) {
        if (currentDetailNodeId) {
          fetchReceptionRate('node', currentDetailNodeId, receptionRange);
        } else {
          setReceptionData(null);
        }
      }
      return;
    }
    setSelectedGwId(gwId);
    if (showReceptionRate) {
      fetchReceptionRate('gateway', gwId, receptionRange);
    }
    try {
      const res = await fetch(`/api/gateway/relayed-nodes/${encodeURIComponent(gwId)}`);
      const data = await res.json();
      setRelayedNodesData(data);
    } catch (err) {
      console.error("Fetch relayed nodes error:", err);
    }
  };

  const MapController = ({ center }: { center?: [number, number] }) => {
    const map = useMap();
    useEffect(() => {
      if (center) {
        map.flyTo(center, 14);
      }
    }, [center, map]);
    return null;
  };

  const MapInvalidator = () => {
    const map = useMap();
    useEffect(() => {
      const timer = setTimeout(() => {
        try {
          if (map && map.getContainer()) {
            map.invalidateSize();
          }
        } catch (e) {
          // ignore map invalidated after unmount
        }
      }, 100);
      return () => clearTimeout(timer);
    }, [activeTab, isMapFullScreen, map]);
    return null;
  };

  // 找出有座標的 Gateway 節點
  const gatewayMarkers = gateways.map(gw => {
    const gwInfo = allNodes.find(n => n.node_id === gw.gateway_id);
    if (gwInfo && gwInfo.latitude && gwInfo.longitude) {
      return {
        ...gw,
        latitude: gwInfo.latitude,
        longitude: gwInfo.longitude,
        short_name: gwInfo.short_name
      };
    }
    return null;
  }).filter(Boolean);

  return (
    <div 
      className="relative w-full h-full"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <MapContainer center={[23.6, 121]} zoom={7} className="w-full h-full" style={{ width: '100%', height: '100%' }}>
        <MapInvalidator />
        <MapController center={mapCenter} />
        <MapEventListener />
        <AppTileLayer tileStyle={tileStyle} darkMode={darkMode} />

        {/* 📡 全台 3D 地形電波覆蓋熱區 (Longley-Rice ITM 烘焙圖層) */}
        {showItmCoverage && (
          <ImageOverlay
            url={`/coverage/taiwan_coverage.png?t=${itmMeta?.updated_at || ''}`}
            bounds={itmMeta?.bounds || [[21.8, 119.3], [25.5, 122.2]]}
            opacity={0.7}
            zIndex={350}
          />
        )}

        {/* 1. 繪製網格圖層 (覆蓋範圍 Coverage & 跳轉分析 Hop Analysis) */}
        {(showTraceroute || showHopGrid) && coverageData.map((grid, i) => {
          // 計算網格邊界 (對應後端 0.005 的精度)
          const lat = Number(grid.grid_lat);
          const lng = Number(grid.grid_lng);
          const bounds = [
            [lat - 0.0025, lng - 0.0025],
            [lat + 0.0025, lng + 0.0025]
          ];

          if (showHopGrid) {
            // 跳轉分析模式：根據 latest_hops 著色
            return (
              <Rectangle
                key={`hop-grid-${i}`}
                bounds={bounds as any}
                pathOptions={{
                  fillColor: getHopColor(grid.latest_hops),
                  fillOpacity: 0.6,
                  stroke: true,
                  color: 'white',
                  weight: 0.5
                }}
              >
                <Tooltip sticky>
                  <div className="text-[11px] font-black p-1">
                    🚀 網格跳轉監控 (Hop Trace)<br />
                    <span className="text-indigo-600">最新跳數: {grid.latest_hops ?? 0} Hops</span><br />
                    <span className="text-blue-500">歷史最優: {grid.min_hops} Hops</span><br />
                    <span className="text-slate-400">最後更新: {grid.latest_time && typeof grid.latest_time === 'string' ? new Date(grid.latest_time.includes(' ') ? grid.latest_time.replace(' ', 'T') + 'Z' : grid.latest_time).toLocaleString() : '--'}</span><br />
                    <span className="text-slate-400">總計封包: {grid.packet_count} pkts</span>
                  </div>
                </Tooltip>
              </Rectangle>
            );
          } else if (showTraceroute) {
            // 覆蓋範圍模式：顯示訊號密度 (白底高對比湛藍漸層，點位清晰分明)
            const opacity = Math.min(0.85, 0.38 + (grid.packet_count / 15));
            return (
              <Rectangle
                key={`cov-grid-${i}`}
                bounds={bounds as any}
                pathOptions={{
                  fillColor: '#0284c7',
                  fillOpacity: opacity,
                  stroke: true,
                  color: '#0369a1',
                  weight: 1
                }}
              >
                <Tooltip sticky>
                  <div className="text-[11px] font-black p-1">
                    📡 區域訊號覆蓋 (Coverage)<br />
                    <span className="text-cyan-600">封包密度: {grid.packet_count} pkts</span><br />
                    <span className="text-slate-500">最新收到: {grid.latest_time && typeof grid.latest_time === 'string' ? new Date(grid.latest_time.includes(' ') ? grid.latest_time.replace(' ', 'T') + 'Z' : grid.latest_time).toLocaleString() : '--'}</span><br />
                    <span className="text-slate-500">平均 SNR: {grid.avg_snr?.toFixed(2)} dB</span>
                  </div>
                </Tooltip>
              </Rectangle>
            );
          }
          return null;
        })}

        {/* 2. 🛰️ 繪製多條 Traceroute 路徑（含每跳 SNR，以新舊著色） - 整合至拓撲邏輯連線圖層 */}
        {showLogicGraph && traceroutePaths.length > 0 && traceroutePaths.map((path) => {
          // 依封包時間計算年齡，決定顏色與透明度
          const ageMs = Date.now() - new Date(path.timestamp.replace(' ', 'T') + 'Z').getTime();
          const ageMin = ageMs / 60000;
          let pathColor = '#06b6d4';   // < 15 min: 亮青
          let pathOpacity = 0.92;
          if (ageMin > 60) { pathColor = '#6366f1'; pathOpacity = 0.55; } // > 1h: 靛藍
          else if (ageMin > 15) { pathColor = '#3b82f6'; pathOpacity = 0.75; } // 15-60min: 藍

          const getSnrColor = (snr: number | null) => {
            if (snr === null) return '#94a3b8';
            if (snr > 5) return '#22c55e';
            if (snr > -5) return '#eab308';
            if (snr > -10) return '#f97316';
            return '#ef4444';
          };

          const validHops = path.hops.filter(h => h.latitude && h.longitude);
          if (validHops.length < 2) return null;

          return (
            <React.Fragment key={path.id}>
              {/* 路徑連線 */}
              <Polyline
                positions={validHops.map(h => [h.latitude, h.longitude]) as any}
                pathOptions={{ color: pathColor, weight: 3, dashArray: '8, 6', opacity: pathOpacity }}
              />
              {/* 每跳節點標記 */}
              {validHops.map((hop, hIdx) => {
                const isSource = hIdx === 0;
                const isGateway = hIdx === validHops.length - 1;
                const snrColor = getSnrColor(hop.snr);
                return (
                  <CircleMarker
                    key={`${path.id}-h${hIdx}`}
                    center={[hop.latitude, hop.longitude]}
                    radius={isSource || isGateway ? 7 : 5}
                    pathOptions={{
                      fillColor: isSource ? '#f59e0b' : isGateway ? '#10b981' : snrColor,
                      color: 'white',
                      weight: 2,
                      fillOpacity: 0.92
                    }}
                  >
                    <Tooltip sticky>
                      <div className="text-[11px] font-mono p-1 leading-relaxed">
                        {isSource && <span className="text-amber-600 font-black">🚀 發送源點</span>}
                        {isGateway && <span className="text-emerald-600 font-black">📡 接收閘道</span>}
                        {!isSource && !isGateway && <span className="text-blue-500 font-black">🔀 中繼節點 #{hIdx}</span>}
                        <br />
                        <span className="text-slate-700">{hop.name}</span><br />
                        {hop.snr !== null && (
                          <span style={{ color: snrColor }} className="font-bold">
                            入站 SNR: {hop.snr} dB
                          </span>
                        )}
                        {hop.snr === null && <span className="text-slate-400">SNR: 起點無入站</span>}
                        <br />
                        <span className="text-slate-400 text-[10px]">
                          {new Date(path.timestamp.replace(' ', 'T') + 'Z').toLocaleString()}
                        </span>
                      </div>
                    </Tooltip>
                  </CircleMarker>
                );
              })}
            </React.Fragment>
          );
        })}
        {/* Fallback: 無多路徑資料時顯示單筆最新路徑 */}
        {showLogicGraph && traceroutePaths.length === 0 && traceroutePath.length >= 2 && (
          <React.Fragment>
            <Polyline
              positions={traceroutePath.map(n => [n.latitude, n.longitude]) as any}
              pathOptions={{ color: '#f59e0b', weight: 4, dashArray: '10, 10', opacity: 0.8 }}
            />
            {traceroutePath.map((p, idx) => (
              <CircleMarker
                key={`tr-${idx}`}
                center={[p.latitude, p.longitude]}
                radius={idx === 0 || idx === traceroutePath.length - 1 ? 6 : 4}
                pathOptions={{ fillColor: idx === 0 ? '#f59e0b' : '#ef4444', color: 'white', weight: 2, fillOpacity: 1 }}
              >
                <Tooltip>路徑節點: {p.short_name || p.node_id}</Tooltip>
              </CircleMarker>
            ))}
          </React.Fragment>
        )}

        {/* 🚀 新增：繪製歷史移動軌跡 (Tracker History) */}
        {showTrackerHistory && selectedNodePath && selectedNodePath.length >= 2 && (
          <React.Fragment>
            <Polyline
              positions={selectedNodePath.map(p => [p.latitude, p.longitude]) as any}
              pathOptions={{ color: '#ec4899', weight: 4, opacity: 0.6, dashArray: '5, 10' }}
            />
            {selectedNodePath.map((p, idx) => (
              <CircleMarker
                key={`th-${idx}`}
                center={[p.latitude, p.longitude]}
                radius={idx === selectedNodePath.length - 1 ? 6 : 3}
                pathOptions={{ 
                  fillColor: idx === selectedNodePath.length - 1 ? '#ec4899' : '#fbcfe8', 
                  color: idx === selectedNodePath.length - 1 ? 'white' : '#ec4899', 
                  weight: idx === selectedNodePath.length - 1 ? 2 : 1, 
                  fillOpacity: 0.8 
                }}
              >
                <Tooltip sticky>
                  <div className="text-[10px] p-1 font-sans">
                    時間: {new Date(p.timestamp).toLocaleString()}<br />
                    接收閘道: {p.gateway_id || 'Unknown'}<br />
                    訊號品質: SNR {p.snr !== null && p.snr !== undefined ? p.snr + ' dB' : 'N/A'} / RSSI {p.rssi !== null && p.rssi !== undefined ? p.rssi + ' dBm' : 'N/A'}
                  </div>
                </Tooltip>
              </CircleMarker>
            ))}
            {/* Draw lines to gateways for each track point */}
            {selectedNodePath.map((p, idx) => {
              if (!p.gateway_id) return null;
              const gwNode = allNodes.find(n => n.node_id === p.gateway_id);
              if (gwNode && gwNode.latitude && gwNode.longitude) {
                return (
                  <Polyline
                    key={`gw-link-${idx}`}
                    positions={[[p.latitude, p.longitude], [gwNode.latitude, gwNode.longitude]] as any}
                    pathOptions={{ color: '#10b981', weight: 1.5, opacity: 0.4, dashArray: '3, 6' }}
                  >
                    <Tooltip sticky>
                      <div className="text-[10px] font-mono p-1">
                        📡 收發路徑 | 時間: {new Date(p.timestamp).toLocaleString()}<br />
                        閘道器: {gwNode.short_name || gwNode.node_id}<br />
                        訊號品質: SNR {p.snr !== null && p.snr !== undefined ? p.snr + ' dB' : 'N/A'} / RSSI {p.rssi !== null && p.rssi !== undefined ? p.rssi + ' dBm' : 'N/A'}
                      </div>
                    </Tooltip>
                  </Polyline>
                );
              }
              return null;
            })}
          </React.Fragment>
        )}        {/* 3. 繪製地理邏輯拓撲連線 (Geographic Logic Topology Network Links) */}
        {showLogicGraph && fusionEdges && fusionEdges.map((edge, idx) => {
          const sourceNode = allNodes.find(n => String(n.node_id).toLowerCase() === String(edge.source_id).toLowerCase());
          const targetNode = allNodes.find(n => String(n.node_id).toLowerCase() === String(edge.target_id).toLowerCase());
          
          if (sourceNode && targetNode && sourceNode.latitude && sourceNode.longitude && targetNode.latitude && targetNode.longitude) {
            // Get color based on method
            let color = '#94a3b8'; // Slate (Default)
            if (edge.method === 'NEIGHBOR_INFO') color = '#22c55e'; // Green (Direct neighbor info)
            if (edge.method === 'TRACEROUTE') color = '#3b82f6'; // Blue (Traceroute path)
            if (edge.method === 'HOP_LIMIT') color = '#f59e0b'; // Orange (Hop limit estimation)
            
            // Map confidence to opacity
            const opacity = Math.max(0.15, Math.min(0.7, edge.confidence / 100));
            const weight = edge.method === 'NEIGHBOR_INFO' ? 4 : (edge.method === 'TRACEROUTE' ? 3 : 2);
            
            return (
              <Polyline
                key={`topo-edge-${idx}`}
                positions={[[sourceNode.latitude, sourceNode.longitude], [targetNode.latitude, targetNode.longitude]] as any}
                pathOptions={{ color, weight, opacity }}
              >
                <Tooltip sticky>
                  <div className="text-[11px] font-black p-1">
                    🔗 拓撲連線 ({edge.method === 'NEIGHBOR_INFO' ? '鄰居直連' : edge.method === 'TRACEROUTE' ? '路徑追蹤' : '跳數估算'})<br />
                    <span className="text-slate-600">起點: {sourceNode.long_name || sourceNode.short_name || sourceNode.node_id}</span><br />
                    <span className="text-slate-600">終點: {targetNode.long_name || targetNode.short_name || targetNode.node_id}</span><br />
                    <span className="text-indigo-600 font-bold">SNR: {edge.snr !== null && edge.snr !== undefined ? edge.snr + ' dB' : 'N/A'}</span><br />
                    <span className="text-emerald-600 font-bold">信心度: {edge.confidence}%</span>
                  </div>
                </Tooltip>
              </Polyline>
            );
          }
          return null;
        })}

        {/* 繪製主節點（含 Cluster 群組化解決重疊問題） */}
        {showNodes && (
          <MarkerClusterGroup
            chunkedLoading
            maxClusterRadius={40}
            spiderfyOnMaxZoom
            showCoverageOnHover={false}
            iconCreateFunction={(cluster: any) => {
              const count = cluster.getChildCount();
              const size = count < 5 ? 32 : count < 15 ? 38 : 44;
              return L.divIcon({
                html: `<div style="
                  width:${size}px;height:${size}px;
                  background:linear-gradient(135deg,#0ea5e9,#6366f1);
                  border:2.5px solid white;
                  border-radius:50%;
                  display:flex;align-items:center;justify-content:center;
                  color:white;font-weight:900;font-size:${count<10?13:11}px;
                  box-shadow:0 3px 10px rgba(0,0,0,0.3);
                  font-family:sans-serif;
                ">${count}</div>`,
                className: '',
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
              });
            }}
          >
            {nodeMarkers}
          </MarkerClusterGroup>
        )}



        {/* 繪製頻道利用率圖層 (Utilization Heat Rings) */}
        {showUtilization && allNodes.filter(n => n.latitude && n.longitude).map(node => {
          const util = node.channel_utilization || 0;
          if (util === 0) return null;
          const color = util > 40 ? '#ef4444' : util > 20 ? '#f59e0b' : '#22c55e';
          return (
            <CircleMarker
              key={`util-${node.node_id}`}
              center={[node.latitude!, node.longitude!]}
              radius={15 + (util / 2)}
              pathOptions={{ fillColor: color, color: color, weight: 1, fillOpacity: 0.2 }}
            >
              <Tooltip direction="top">利用率: {util.toFixed(1)}%</Tooltip>
            </CircleMarker>
          );
        })}

        {/* 繪製 Gateway 節點 (圓點表示) */}
        {(() => {
          const maxPackets = Math.max(1, ...gatewayMarkers.map((gw: any) => gw.total_packets || gw.count || 0));
          return gatewayMarkers.map((gw: any) => {
            const packets = gw.total_packets || gw.count || 0;
            const hops = gw.hop_start - gw.hop_limit;
            const isSelected = selectedGwId === gw.gateway_id;
            return (
              <React.Fragment key={gw.gateway_id}>
                <CircleMarker
                  center={[gw.latitude, gw.longitude]}
                  radius={isDetailView ? 12 : 8 + (packets / maxPackets) * 32}
                  pathOptions={{
                    fillColor: isSelected ? '#06b6d4' : getRecencyColor(gw.last_seen || gw.last_active),
                    color: isSelected ? '#38bdf8' : '#fff',
                    weight: isSelected ? 4 : 2,
                    fillOpacity: 0.95
                  }}
                  eventHandlers={{
                    click: () => handleGatewayClick(gw.gateway_id)
                  }}
                >
                  <Popup>
                    <div className="font-sans text-xs space-y-1">
                      <strong className="text-cyan-600">📡 Gateway: {gw.short_name || gw.gateway_id}</strong><br />
                      <span>Hops: {hops}</span><br />
                      <span>經手封包數: {packets} pkts</span><br />
                      <span className="text-[10px] text-slate-400 font-mono">點擊解鎖經手節點連線圖層</span>
                    </div>
                  </Popup>
                </CircleMarker>

                {/* 繪製連線 (如果主節點有 GPS) */}
                {isDetailView && nodesWithGPS[0] && (
                  <Polyline
                    positions={[[nodesWithGPS[0].latitude!, nodesWithGPS[0].longitude!], [gw.latitude, gw.longitude]]}
                    pathOptions={{
                      color: getRecencyColor(gw.last_seen || gw.last_active),
                      weight: Math.min(12, 2 + (gw.count / 5)),
                      dashArray: hops > 0 ? '5, 5' : undefined,
                      opacity: 0.8
                    }}
                  >
                    <Tooltip sticky>
                      <div className="text-xs font-sans p-1">
                        <div className="font-bold border-b border-slate-100 mb-1 pb-1">路徑資訊 Path Info</div>
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">跳數 Hops:</span>
                          <span className="font-bold text-blue-600">{hops}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">最後收信:</span>
                          <span className="text-slate-600">{new Date(gw.last_seen).toLocaleString()}</span>
                        </div>
                      </div>
                    </Tooltip>
                  </Polyline>
                )}
              </React.Fragment>
            );
          });
        })()}

        {/* 🛰️ 閘道器經手節點實時連線 Polyline */}
        {relayedNodesData && selectedGwId && (() => {
          const gwNode = gatewayMarkers.find((g: any) => g.gateway_id === selectedGwId);
          if (!gwNode) return null;
          return relayedNodesData.relayedNodes.map((rn: any) => {
            if (!rn.latitude || !rn.longitude) return null;
            return (
              <Polyline
                key={`gw-relayed-link-${rn.node_id}`}
                positions={[[gwNode.latitude, gwNode.longitude], [rn.latitude, rn.longitude]]}
                pathOptions={{
                  color: '#06b6d4',
                  weight: 2.5,
                  opacity: 0.8,
                  dashArray: '5, 8',
                }}
              >
                <Tooltip sticky>
                  <div className="text-[10px] font-mono p-1 space-y-0.5">
                    <strong className="text-cyan-400">📡 閘道經手連線 | {rn.short_name || rn.long_name || rn.node_id}</strong><br />
                    <span>經手封包數: <strong>{rn.packet_count} pkts</strong></span><br />
                    <span>最後活動: {new Date(rn.last_activity).toLocaleTimeString()}</span><br />
                    <span>平均 SNR: {rn.avg_snr ?? '--'} dB | RSSI: {rn.avg_rssi ?? '--'} dBm</span>
                  </div>
                </Tooltip>
              </Polyline>
            );
          });
        })()}

        {/* 📊 遙測封包接收成功率 (PRR) 雙向動態連線圖層 */}
        {showReceptionRate && receptionData && (() => {
          // 視角 1：節點出發 (Node-centric)
          if (receptionData.target_type === 'node' && receptionData.node?.latitude && receptionData.node?.longitude) {
            const srcLat = receptionData.node.latitude;
            const srcLng = receptionData.node.longitude;
            const nodeName = receptionData.node.short_name || receptionData.node.node_id;

            return (
              <React.Fragment>
                {/* 發射源節點外圍呼吸光環 */}
                <CircleMarker
                  center={[srcLat, srcLng]}
                  radius={13}
                  pathOptions={{
                    color: '#10b981',
                    fillColor: '#10b981',
                    fillOpacity: 0.35,
                    weight: 2
                  }}
                />
                {receptionData.gateways?.map((gw: any) => {
                  if (!gw.latitude || !gw.longitude) return null;
                  const isHigh = gw.success_rate >= 80;
                  const isMid = gw.success_rate >= 50 && gw.success_rate < 80;
                  const color = isHigh ? '#10b981' : isMid ? '#f59e0b' : '#f43f5e';
                  const weight = isHigh ? 3.5 : isMid ? 2.5 : 1.8;
                  const dashArray = isHigh ? undefined : isMid ? '8, 4' : '4, 6';
                  const opacity = isHigh ? 0.9 : isMid ? 0.75 : 0.6;

                  return (
                    <React.Fragment key={`prr-node-link-${gw.gateway_id}`}>
                      <Polyline
                        positions={[[srcLat, srcLng], [gw.latitude, gw.longitude]]}
                        pathOptions={{ color, weight, opacity, dashArray }}
                      >
                        <Tooltip sticky>
                          <div className="text-[11px] font-mono p-1 space-y-1">
                            <div className="font-bold flex items-center justify-between gap-3 border-b border-slate-700/60 pb-1" style={{ color }}>
                              <span>📡 遙測接收率: {gw.success_rate}%</span>
                              <span className="text-[10px] text-slate-400">({gw.received_rounds}/{gw.expected_rounds} 回合)</span>
                            </div>
                            <div className="text-slate-200">
                              節點: <b>{nodeName}</b> ➔ 網關: <b>{gw.short_name}</b>
                            </div>
                            {gw.distance_km !== null && (
                              <div className="text-cyan-400 font-bold">直線距離: {gw.distance_km} km</div>
                            )}
                            <div className="text-slate-400 text-[10px]">
                              SNR: {gw.avg_snr !== null ? `${gw.avg_snr} dB` : 'N/A'} | RSSI: {gw.avg_rssi !== null ? `${gw.avg_rssi} dBm` : 'N/A'}
                            </div>
                            <div className="text-amber-300 text-[10px]">
                              路徑: {gw.is_direct ? '🟢 直收 (0-Hop)' : `🟡 中繼 (${gw.avg_hops} Hops)`}
                            </div>
                          </div>
                        </Tooltip>
                      </Polyline>
                      <CircleMarker
                        center={[gw.latitude, gw.longitude]}
                        radius={7}
                        pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 2 }}
                      />
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          }

          // 視角 2：網關接收 (Gateway-centric)
          if (receptionData.target_type === 'gateway' && receptionData.gateway?.latitude && receptionData.gateway?.longitude) {
            const gwLat = receptionData.gateway.latitude;
            const gwLng = receptionData.gateway.longitude;
            const gwName = receptionData.gateway.short_name || receptionData.gateway.node_id;

            return (
              <React.Fragment>
                {/* 接收端網關外圍呼吸光環 */}
                <CircleMarker
                  center={[gwLat, gwLng]}
                  radius={14}
                  pathOptions={{
                    color: '#06b6d4',
                    fillColor: '#06b6d4',
                    fillOpacity: 0.4,
                    weight: 2.5
                  }}
                />
                {receptionData.nodes?.map((n: any) => {
                  if (!n.latitude || !n.longitude) return null;
                  const isHigh = n.success_rate >= 80;
                  const isMid = n.success_rate >= 50 && n.success_rate < 80;
                  const color = isHigh ? '#10b981' : isMid ? '#f59e0b' : '#f43f5e';
                  const weight = isHigh ? 3.5 : isMid ? 2.5 : 1.8;
                  const dashArray = isHigh ? undefined : isMid ? '8, 4' : '4, 6';
                  const opacity = isHigh ? 0.9 : isMid ? 0.75 : 0.6;

                  return (
                    <React.Fragment key={`prr-gw-link-${n.node_id}`}>
                      <Polyline
                        positions={[[n.latitude, n.longitude], [gwLat, gwLng]]}
                        pathOptions={{ color, weight, opacity, dashArray }}
                      >
                        <Tooltip sticky>
                          <div className="text-[11px] font-mono p-1 space-y-1">
                            <div className="font-bold flex items-center justify-between gap-3 border-b border-slate-700/60 pb-1" style={{ color }}>
                              <span>🛰️ 網關接收率: {n.success_rate}%</span>
                              <span className="text-[10px] text-slate-400">({n.received_rounds}/{n.expected_rounds} 回合)</span>
                            </div>
                            <div className="text-slate-200">
                              來源: <b>{n.short_name}</b> ➔ 網關: <b>{gwName}</b>
                            </div>
                            {n.distance_km !== null && (
                              <div className="text-cyan-400 font-bold">直線距離: {n.distance_km} km</div>
                            )}
                            <div className="text-slate-400 text-[10px]">
                              SNR: {n.avg_snr !== null ? `${n.avg_snr} dB` : 'N/A'} | RSSI: {n.avg_rssi !== null ? `${n.avg_rssi} dBm` : 'N/A'}
                            </div>
                            <div className="text-amber-300 text-[10px]">
                              路徑: {n.is_direct ? '🟢 直收 (0-Hop)' : `🟡 中繼 (${n.avg_hops} Hops)`}
                            </div>
                          </div>
                        </Tooltip>
                      </Polyline>
                      <CircleMarker
                        center={[n.latitude, n.longitude]}
                        radius={6}
                        pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1.5 }}
                      />
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          }

          return null;
        })()}

        {/* --- 動態 Hop 覆蓋模擬器 (Weighted Reachability Map) --- */}
        {showSimulator && simResultMap && simState && simState.sourceNodeId && (() => {
          const hopGroups = new Map<number, Node[]>();
          simResultMap.forEach((info, nodeId) => {
            if (!hopGroups.has(info.hop)) hopGroups.set(info.hop, []);
            const n = allNodes.find(n => n.node_id === nodeId) || localNodes.find(n => n.node_id === nodeId);
            if (n && n.latitude && n.longitude) {
              hopGroups.get(info.hop)!.push(n);
            }
          });

          // Sort descending so larger hops (usually larger area) are drawn first and don't cover smaller ones
          const sortedHops = Array.from(hopGroups.keys()).sort((a, b) => b - a);
          
          return sortedHops.map(hop => {
            const groupNodes = hopGroups.get(hop)!;
            if (groupNodes.length === 0) return null;

            let totalSnr = 0;
            groupNodes.forEach(n => {
              totalSnr += simResultMap.get(n.node_id)!.pathSnr;
            });
            const avgSnr = totalSnr / groupNodes.length;
            
            const isWeak = avgSnr < -10;
            const pathOptions = {
              color: getHopColor(hop),
              weight: isWeak ? 1 : 2,
              dashArray: isWeak ? '10, 10' : undefined,
              fillOpacity: isWeak ? 0.1 : 0.3,
              fillColor: getHopColor(hop)
            };

            const points = groupNodes.map(n => [n.longitude!, n.latitude!] as [number, number]);
            
            if (points.length < 3) {
              return groupNodes.map(n => (
                <Circle 
                  key={`sim-${hop}-${n.node_id}`} 
                  center={[n.latitude!, n.longitude!]} 
                  radius={2000} 
                  pathOptions={pathOptions} 
                >
                  <Tooltip>Hop: {hop} | Avg SNR: {avgSnr.toFixed(1)}</Tooltip>
                </Circle>
              ));
            }

            try {
              const fc = turf.featureCollection(points.map(p => turf.point(p)));
              const hull = turf.convex(fc);
              if (!hull) return null;
              const buffered = turf.buffer(hull, 2, { units: 'kilometers' });
              
              if (!buffered) return null;

              return (
                <GeoJSON key={`sim-poly-${hop}`} data={buffered} pathOptions={pathOptions}>
                  <Tooltip>Hop {hop} Coverage | Avg SNR: {avgSnr.toFixed(1)} | Nodes: {groupNodes.length}</Tooltip>
                </GeoJSON>
              );
            } catch (e) {
              console.error("Turf error", e);
              return null;
            }
          });
        })()}

      </MapContainer>

      {/* 🛰️ 閘道器經手節點詳情 Drawer Popover Panel */}
      {relayedNodesData && (
        <div className="absolute top-4 right-4 z-[1000] w-80 backdrop-blur-md bg-slate-900/90 border border-cyan-500/50 p-4 rounded-2xl shadow-2xl space-y-3 text-slate-100 animate-fadeIn pointer-events-auto">
          <div className="flex items-center justify-between border-b border-slate-700/60 pb-2">
            <div className="font-bold text-xs text-cyan-400 flex items-center gap-1.5 font-mono">
              <span>🛰️</span> 閘道經手封包與對應節點
            </div>
            <button
              onClick={() => { setSelectedGwId(null); setRelayedNodesData(null); }}
              className="text-slate-400 hover:text-white text-xs px-1 font-mono"
            >✕</button>
          </div>

          <div className="flex justify-between items-center text-[11px] font-mono bg-slate-800/80 p-2 rounded-xl border border-slate-700/50">
            <div>
              <span className="text-slate-400 text-[10px]">閘道器 ID:</span> <span className="font-bold text-cyan-300">{relayedNodesData.gatewayId}</span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px]">總經手:</span> <span className="font-bold text-amber-400">{relayedNodesData.totalPackets} pkts</span>
            </div>
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {relayedNodesData.relayedNodes.length === 0 ? (
              <div className="text-slate-500 text-center py-4 text-xs italic font-mono">近 24 小時無經手封包紀錄</div>
            ) : (
              relayedNodesData.relayedNodes.map(rn => (
                <div
                  key={rn.node_id}
                  onClick={() => { onSelectNode(rn.node_id); if (onShowDetail) onShowDetail(rn.node_id); }}
                  className="p-2 rounded-xl bg-slate-800/60 border border-slate-700/40 hover:border-cyan-500/50 hover:bg-slate-800 transition-all cursor-pointer space-y-1"
                >
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-mono font-bold text-cyan-300">{rn.short_name || rn.long_name || rn.node_id}</span>
                    <span className="text-[10px] font-mono bg-cyan-500/20 text-cyan-300 px-1.5 py-0.5 rounded-full">
                      {rn.packet_count} pkts
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-slate-400">
                    <span>SNR {rn.avg_snr ?? '--'}dB / RSSI {rn.avg_rssi ?? '--'}dBm</span>
                    <span>{new Date(rn.last_activity).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 📊 遙測封包接收成功率 (PRR) 雙向分析抽屜面板 */}
      {showReceptionRate && (receptionData || receptionOverview || isLoadingReception) && (
        <div className="absolute top-16 right-4 z-[1000] w-[350px] backdrop-blur-md bg-slate-900/95 border border-emerald-500/50 p-4 rounded-2xl shadow-2xl space-y-3 text-slate-100 animate-fadeIn pointer-events-auto max-h-[80vh] flex flex-col">
          {/* 面板頂部標題與控制項 */}
          <div className="flex items-center justify-between border-b border-slate-700/60 pb-2">
            <div className="font-bold text-xs text-emerald-400 flex items-center gap-1.5 font-mono">
              <BarChart2 size={14} />
              <span>
                {receptionData?.target_type === 'node'
                  ? `📡 ${receptionData.node?.short_name || receptionData.node?.node_id || nodes[0]?.short_name || '節點'} 遙測接收率 (PRR)`
                  : receptionData?.target_type === 'gateway'
                    ? '🛰️ 網關接收 ➔ 周遭節點成功率'
                    : `📡 ${nodes[0]?.short_name || '該節點'} 遙測接收率 (PRR)`}
              </span>
              {isLoadingReception && <span className="ml-1 text-[10px] animate-pulse text-emerald-400">...</span>}
            </div>
            <div className="flex items-center gap-1">
              <div className="flex bg-slate-800 rounded-lg p-0.5 border border-slate-700 text-[10px] font-mono">
                <button
                  onClick={() => setReceptionRange('24h')}
                  className={`px-1.5 py-0.5 rounded-md transition-all ${receptionRange === '24h' ? 'bg-emerald-500 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
                >24h</button>
                <button
                  onClick={() => setReceptionRange('7d')}
                  className={`px-1.5 py-0.5 rounded-md transition-all ${receptionRange === '7d' ? 'bg-emerald-500 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
                >7d</button>
                <button
                  onClick={() => setReceptionRange('30d')}
                  className={`px-1.5 py-0.5 rounded-md transition-all ${receptionRange === '30d' ? 'bg-emerald-500 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
                >30d</button>
              </div>
              <button
                onClick={() => { setReceptionData(null); setReceptionOverview(null); setShowReceptionRate(false); }}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 font-mono ml-1 hover:bg-slate-800 rounded"
              >✕</button>
            </div>
          </div>

          {isLoadingReception && !receptionData && (
            <div className="py-8 text-center text-xs font-mono text-slate-400">
              <div className="inline-block w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-2" />
              <div>正在分析「{nodes[0]?.short_name || nodes[0]?.node_id || '該節點'}」接收率...</div>
            </div>
          )}

          {/* 視角詳情摘要卡片 */}
          {receptionData?.target_type === 'node' && (
            <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700/60 text-[11px] font-mono space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">當前節點:</span>
                <span className="font-bold text-emerald-300">{receptionData.node?.short_name || receptionData.node?.node_id}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">推算心跳週期:</span>
                <span className="font-bold text-amber-300">約 {Math.round((receptionData.estimated_interval_sec || 1800) / 60)} 分鐘/次</span>
              </div>
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-400">理論預期回合:</span>
                <span className="text-cyan-300 font-bold">{receptionData.expected_rounds} 回合 (全網觀測: {receptionData.global_observed_rounds})</span>
              </div>
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-400">成功捕獲網關數:</span>
                <span className="text-emerald-400 font-bold">{receptionData.gateways?.length || 0} 個</span>
              </div>
            </div>
          )}

          {receptionData?.target_type === 'gateway' && (
            <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700/60 text-[11px] font-mono space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">當前閘道器:</span>
                <span className="font-bold text-cyan-300">{receptionData.gateway?.short_name || receptionData.gateway?.node_id}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">收到節點總數:</span>
                <span className="font-bold text-emerald-300">{receptionData.total_nodes_received || 0} 個節點</span>
              </div>
              <div className="text-[10px] text-slate-400 pt-0.5">
                💡 依各節點理論心跳計算該網關的單站捕獲成功率
              </div>
              {isDetailView && currentDetailNodeId && (
                <button
                  onClick={() => {
                    setSelectedGwId(null);
                    fetchReceptionRate('node', currentDetailNodeId, receptionRange);
                  }}
                  className="w-full mt-1.5 py-1 px-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white text-[10px] font-bold transition flex items-center justify-center gap-1 shadow"
                >
                  🔙 返回「{nodes[0]?.short_name || currentDetailNodeId}」節點接收率
                </button>
              )}
            </div>
          )}

          {/* 滾動清單 */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 max-h-60">
            {/* 節點視角清單 */}
            {receptionData?.target_type === 'node' && (
              receptionData.gateways?.length === 0 ? (
                <div className="text-slate-500 text-center py-4 text-xs italic font-mono">在此時窗內無網關接收紀錄</div>
              ) : (
                receptionData.gateways?.map((gw: any) => {
                  const isHigh = gw.success_rate >= 80;
                  const isMid = gw.success_rate >= 50 && gw.success_rate < 80;
                  const barColor = isHigh ? 'bg-emerald-500' : isMid ? 'bg-amber-500' : 'bg-rose-500';
                  const textColor = isHigh ? 'text-emerald-400' : isMid ? 'text-amber-400' : 'text-rose-400';

                  return (
                    <div
                      key={gw.gateway_id}
                      onClick={() => handleGatewayClick(gw.gateway_id)}
                      className="p-2 rounded-xl bg-slate-800/60 border border-slate-700/40 hover:border-emerald-500/50 hover:bg-slate-800 transition-all cursor-pointer space-y-1"
                    >
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-mono font-bold text-slate-200">
                          {gw.short_name || gw.gateway_id}
                          {gw.distance_km !== null && <span className="text-[10px] text-cyan-400 font-normal ml-1">({gw.distance_km} km)</span>}
                        </span>
                        <span className={`text-[11px] font-mono font-bold ${textColor}`}>
                          {gw.success_rate}%
                        </span>
                      </div>
                      <div className="w-full bg-slate-700/50 rounded-full h-1.5 overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${Math.min(100, gw.success_rate)}%` }}></div>
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-0.5">
                        <span>{gw.received_rounds}/{gw.expected_rounds} 回合</span>
                        <span>{gw.is_direct ? '0-Hop 直收' : `${gw.avg_hops} Hops`} | {gw.avg_snr ?? '--'}dB</span>
                      </div>
                    </div>
                  );
                })
              )
            )}

            {/* 閘道器視角清單 */}
            {receptionData?.target_type === 'gateway' && (
              receptionData.nodes?.length === 0 ? (
                <div className="text-slate-500 text-center py-4 text-xs italic font-mono">無經手接收遙測紀錄</div>
              ) : (
                receptionData.nodes?.map((n: any) => {
                  const isHigh = n.success_rate >= 80;
                  const isMid = n.success_rate >= 50 && n.success_rate < 80;
                  const barColor = isHigh ? 'bg-emerald-500' : isMid ? 'bg-amber-500' : 'bg-rose-500';
                  const textColor = isHigh ? 'text-emerald-400' : isMid ? 'text-amber-400' : 'text-rose-400';

                  return (
                    <div
                      key={n.node_id}
                      onClick={() => { onSelectNode(n.node_id); if (onShowDetail) onShowDetail(n.node_id); }}
                      className="p-2 rounded-xl bg-slate-800/60 border border-slate-700/40 hover:border-cyan-500/50 hover:bg-slate-800 transition-all cursor-pointer space-y-1"
                    >
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-mono font-bold text-slate-200">
                          {n.short_name || n.node_id}
                          {n.distance_km !== null && <span className="text-[10px] text-cyan-400 font-normal ml-1">({n.distance_km} km)</span>}
                        </span>
                        <span className={`text-[11px] font-mono font-bold ${textColor}`}>
                          {n.success_rate}%
                        </span>
                      </div>
                      <div className="w-full bg-slate-700/50 rounded-full h-1.5 overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${Math.min(100, n.success_rate)}%` }}></div>
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-0.5">
                        <span>{n.received_rounds}/{n.expected_rounds} 回合</span>
                        <span>{n.is_direct ? '0-Hop 直收' : `${n.avg_hops} Hops`} | {n.avg_snr ?? '--'}dB</span>
                      </div>
                    </div>
                  );
                })
              )
            )}

            {/* 總覽模式：引導點選或快速選取熱門項目 */}
            {!receptionData && receptionOverview && (
              <div className="space-y-2 text-xs font-mono">
                <div className="text-[11px] text-slate-300 bg-slate-800/60 p-2 rounded-xl border border-slate-700/50">
                  👆 點選地圖上的任一<b>節點</b>或<b>網關</b>，立即繪製雙向接收成功率連線！或直接從下方熱門清單中選取：
                </div>
                <div>
                  <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-1">🔥 活躍節點 (多網關覆蓋)</div>
                  <div className="space-y-1">
                    {receptionOverview.top_nodes?.map((tn: any) => (
                      <div
                        key={tn.node_id}
                        onClick={() => fetchReceptionRate('node', tn.node_id, receptionRange)}
                        className="flex justify-between items-center p-1.5 rounded-lg bg-slate-800/40 hover:bg-emerald-950/40 hover:border-emerald-500/40 border border-transparent cursor-pointer"
                      >
                        <span className="font-bold text-slate-200">{tn.short_name || tn.node_id}</span>
                        <span className="text-[10px] text-emerald-400">{tn.gw_count} 個網關收到</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-1">
                  <div className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider mb-1">🛰️ 核心網關 (覆蓋多節點)</div>
                  <div className="space-y-1">
                    {receptionOverview.top_gateways?.map((tg: any) => (
                      <div
                        key={tg.gateway_id}
                        onClick={() => fetchReceptionRate('gateway', tg.gateway_id, receptionRange)}
                        className="flex justify-between items-center p-1.5 rounded-lg bg-slate-800/40 hover:bg-cyan-950/40 hover:border-cyan-500/40 border border-transparent cursor-pointer"
                      >
                        <span className="font-bold text-slate-200">{tg.short_name || tg.gateway_id}</span>
                        <span className="text-[10px] text-cyan-400">{tg.node_count} 個節點覆蓋</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 🗺️ 地圖風格切換按鈕 (右上控制群組) */}
      <div className="absolute top-4 right-16 z-[1000] flex items-center gap-2 pointer-events-auto">
        {/* PRR 切換按鈕：只在詳情地圖內顯示 */}
        {isDetailView && (
          <button
            onClick={() => {
              const next = !showReceptionRate;
              setShowReceptionRate(next);
              if (next) {
                setRelayedNodesData(null);
                setSelectedGwId(null);
                if (currentDetailNodeId) {
                  fetchReceptionRate('node', currentDetailNodeId, receptionRange);
                } else {
                  fetchReceptionRate('overview', undefined, receptionRange);
                }
              } else {
                setReceptionData(null);
                setReceptionOverview(null);
              }
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-mono font-bold flex items-center gap-1.5 backdrop-blur-md shadow-lg border transition-all ${
              showReceptionRate
                ? 'bg-emerald-600/90 text-white border-emerald-400 shadow-emerald-950/50 ring-2 ring-emerald-500/40'
                : darkMode
                  ? 'bg-slate-900/80 text-slate-300 border-slate-700/80 hover:bg-slate-800 hover:text-white'
                  : 'bg-white/90 text-slate-700 border-slate-200 hover:bg-slate-100 hover:text-slate-900'
            }`}
            title="切換顯示節點與閘道器遙測封包接收成功率 (PRR)"
          >
            <BarChart2 size={13} className={showReceptionRate ? 'text-white' : 'text-emerald-400'} />
            <span>PRR 成功率</span>
            {isLoadingReception && <span className="animate-spin text-[10px]">⏳</span>}
          </button>
        )}

        <MapStyleSelector
          currentStyle={tileStyle}
          onSelect={setTileStyle}
          darkMode={darkMode}
        />
      </div>

      {/* 圖例 Legend Overlay */}
      <div className={`absolute bottom-4 right-4 backdrop-blur-md p-3 rounded-xl shadow-xl z-[1000] border pointer-events-auto min-w-[160px] transition-all duration-300 ${
        darkMode 
          ? 'bg-slate-900/90 border-slate-700/80 text-slate-200 shadow-slate-950/50' 
          : 'bg-white/90 border-slate-200 text-slate-700'
      }`}>
        <div
          className="flex items-center justify-between cursor-pointer group"
          onClick={() => setIsLegendExpanded(!isLegendExpanded)}
        >
          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
            <Info size={12} /> 地圖圖例 Legend
          </h4>
          {isLegendExpanded ? <ChevronDown size={14} className="text-slate-400 group-hover:text-cyan-500" /> : <ChevronUp size={14} className="text-slate-400 group-hover:text-cyan-500" />}
        </div>

        {isLegendExpanded && activeTab === 'gateways' && (
          <div className="space-y-3 mt-2 pt-2 border-t border-slate-100 overflow-y-auto max-h-[60vh]">
            <div>
              <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">閘道標記 Gateway Info</div>
              <div className="space-y-3 text-[10px] font-bold text-slate-600">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full border-2 border-white bg-blue-500"></div>
                  顏色：最後活躍時間 (越深藍越新，越淺藍越舊)
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full border-2 border-white bg-blue-500 flex items-center justify-center"></div>
                  大小：圈圈大小與 Gateway 收到的封包數量呈正相關
                </div>
              </div>
            </div>
          </div>
        )}

        {isLegendExpanded && activeTab !== 'gateways' && (
          <div className="space-y-3 mt-2 pt-2 border-t border-slate-100 overflow-y-auto max-h-[60vh]">
            {/* 網格圖層說明 */}
            {(showTraceroute || showHopGrid) && (
              <div>
                <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">覆蓋與跳轉分析 Analytics</div>
                <div className="space-y-1">
                  {showTraceroute && (
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-2.5 h-2.5 bg-cyan-500 opacity-60"></span> 覆蓋密度 (Density)
                    </div>
                  )}
                  {showHopGrid && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                        <span className="w-2.5 h-2.5 bg-[#22c55e]"></span> 0 跳 (直接)
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                        <span className="w-2.5 h-2.5 bg-[#eab308]"></span> 2 跳 (中繼)
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                        <span className="w-2.5 h-2.5 bg-[#ef4444]"></span> 5+ 跳 (多級)
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 拓撲與路徑連線說明 */}
            {showLogicGraph && (
              <div>
                <div className="text-[9px] font-bold text-purple-400 mb-1 uppercase tracking-tighter">拓撲邏輯連線 Topology</div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    <span className="w-4 h-0.5 bg-[#22c55e]"></span> 鄰居直連 (Neighbor)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    <span className="w-4 h-0.5 bg-[#3b82f6]"></span> 追蹤路徑 (Traceroute)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    <span className="w-4 h-0.5 bg-[#f59e0b]"></span> 跳數估算 (Hop Limit)
                  </div>
                </div>
              </div>
            )}

            {/* 遙測接收率 (PRR) 圖例說明 */}
            {showReceptionRate && (
              <div>
                <div className="text-[9px] font-bold text-emerald-400 mb-1 uppercase tracking-tighter">遙測接收率 PRR</div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-1 bg-[#10b981] rounded"></span> ≥ 80% (高可靠/主力)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-1 bg-[#f59e0b] rounded"></span> 50%~79% (中等/備援)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-0.5 border-b-2 border-dashed border-[#f43f5e]"></span> &lt; 50% (衰減/邊緣)
                  </div>
                </div>
              </div>
            )}

            {/* 📡 全台 3D 地形電波覆蓋圖例說明 */}
            {showItmCoverage && (
              <div>
                <div className="text-[9px] font-bold text-purple-400 mb-1 uppercase tracking-tighter flex items-center justify-between">
                  <span>全台電波覆蓋 (ITM)</span>
                  {itmMeta?.station_count && (
                    <span className="text-[9px] text-purple-300 font-mono">共 {itmMeta.station_count} 站</span>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-1.5 bg-[#ef4444] rounded"></span> ≥ -75 dBm (極強)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-1.5 bg-[#eab308] rounded"></span> -95 ~ -75 dBm (主力)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-1.5 bg-[#06b6d4] rounded"></span> -115 ~ -95 dBm (可用)
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                    <span className="w-4 h-1.5 bg-[#6366f1] rounded"></span> -130 ~ -115 dBm (邊緣)
                  </div>
                </div>
                {itmMeta?.updated_at && (
                  <div className="text-[8px] text-slate-400 font-mono pt-1">
                    更新: {new Date(itmMeta.updated_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </div>
            )}

            {/* 0. 角色分組 (還原複雜圖例) */}
            <div>
              <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">節點角色 Roles</div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#dc2626]"></span> ROUTER (紅)
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#ea580c]"></span> MOBILE_R (橘)
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#16a34a]"></span> TRACKER (綠)
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#eab308]"></span> MESSENGER (黃)
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#9333ea]"></span> REPEATER (紫)
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#2563eb]"></span> CLIENT (藍)
                </div>
              </div>
            </div>

            {/* 1. 標記說明：使用 Pin 圖示 */}
            <div>
              <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">標記說明 Marker Info</div>
              <div className="space-y-2 text-[10px] font-bold text-slate-600">
                <div className="flex items-center gap-2">
                  <svg width="12" height="18" viewBox="0 0 25 41" fill="none" className="text-blue-500">
                    <path d="M12.5 0C5.596 0 0 5.596 0 12.5C0 21.875 12.5 41 12.5 41C12.5 41 25 21.875 25 12.5C25 5.596 19.404 0 12.5 0Z" fill="currentColor" stroke="white" strokeWidth="1.5" />
                    <circle cx="12.5" cy="12.5" r="4.5" fill="white" />
                  </svg>
                  顏色：節點角色 (Roles)
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1 items-end h-4">
                    <span className="w-2 h-4 bg-blue-500 rounded-sm shadow-[0_0_5px_rgba(59,130,246,0.8)]"></span>
                    <span className="w-2 h-3 bg-blue-400/60 rounded-sm"></span>
                    <span className="w-2 h-2 bg-slate-400/30 rounded-sm"></span>
                  </div>
                  能量：亮+鮮艷 (活躍) / 暗+灰 (陳舊)
                </div>
              </div>
            </div>

            {/* 2. 僅在詳情模式下顯示路徑資訊 */}
            {isDetailView && (
              <>
                <div className="pt-1 border-t border-slate-100">
                  <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">路徑通訊量 Traffic</div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-5 h-0.5 bg-slate-400"></span> 細：封包量少
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-5 h-1.5 bg-slate-400 rounded-full"></span> 粗：封包量大
                    </div>
                  </div>
                </div>

                <div className="pt-1 border-t border-slate-100">
                  <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">中繼跳數 Hops</div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-5 h-0.5 bg-slate-400"></span> 實線：直接接收 (0 跳)
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-5 h-0.5 border-t-2 border-dashed border-slate-400"></span> 虛線：中繼轉發
                    </div>
                  </div>
                </div>

                <div className="pt-1 border-t border-slate-100">
                  <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">路徑收信間隔 Heard</div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#1e3a8a]"></span> &lt; 2 小時 (深)
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#60a5fa]"></span> 6 ~ 12 小時
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#cbd5e1]"></span> 24 小時以上 (淺)
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
export default React.memo(NodeMap);