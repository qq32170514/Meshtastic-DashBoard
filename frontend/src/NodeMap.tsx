import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, Polyline, Tooltip, useMap, Rectangle, GeoJSON, Circle } from 'react-leaflet';
import * as turf from '@turf/turf';
import L from 'leaflet';
import { Node } from './App';
import { Info, ChevronDown, ChevronUp } from 'lucide-react';

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

// 建立自定義彩色圖標 (SVG 渲染)
const createColoredIcon = (role?: string, lastSeen?: string) => {
  const color = getRoleColor(role);
  const { filter } = getRecencyVisuals(lastSeen);
  const baseShadow = 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))';

  return L.divIcon({
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
  fusionEdges?: any[];
  isMapFullScreen?: boolean;
  mapCenter?: [number, number];
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

const NodeMap = ({ nodes, allNodes = [], gateways = [], onSelectNode, onShowDetail, isDetailView = false, showNodes = true, showUtilization = false, showTraceroute = false, traceroutePath = [], neighbors = [], showHopGrid = false, coverageData = [], selectedNodePath = [], showTrackerHistory = false, showSimulator = false, simResultMap, simState, activeTab, showLogicGraph = false, fusionEdges = [], isMapFullScreen = false, mapCenter }: NodeMapProps) => {
  const [isLegendExpanded, setIsLegendExpanded] = useState(false);
  const [mapColorMode, setMapColorMode] = useState<'role' | 'cu'>('role');
  const [selectedGwId, setSelectedGwId] = useState<string | null>(null);
  const [relayedNodesData, setRelayedNodesData] = useState<{
    gatewayId: string;
    relayedCount: number;
    totalPackets: number;
    relayedNodes: any[];
  } | null>(null);

  const nodesWithGPS = nodes.filter(n => n.latitude && n.longitude);

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
      return;
    }
    setSelectedGwId(gwId);
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
      setTimeout(() => {
        map.invalidateSize();
      }, 100);
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
    <div className="relative w-full h-full">
      <MapContainer center={[23.6, 121]} zoom={7} className="w-full h-full" style={{ width: '100%', height: '100%' }}>
        <MapInvalidator />
        <MapController center={mapCenter} />
        <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />

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
                    <span className="text-slate-400">最後更新: {grid.latest_time ? new Date(grid.latest_time.replace(' ', 'T') + 'Z').toLocaleString() : '--'}</span><br />
                    <span className="text-slate-400">總計封包: {grid.packet_count} pkts</span>
                  </div>
                </Tooltip>
              </Rectangle>
            );
          } else if (showTraceroute) {
            // 覆蓋範圍模式：顯示訊號密度 (單色青色漸層)
            const opacity = Math.min(0.8, 0.2 + (grid.packet_count / 20));
            return (
              <Rectangle
                key={`cov-grid-${i}`}
                bounds={bounds as any}
                pathOptions={{
                  fillColor: '#06b6d4',
                  fillOpacity: opacity,
                  stroke: false
                }}
              >
                <Tooltip sticky>
                  <div className="text-[11px] font-black p-1">
                    📡 區域訊號覆蓋 (Coverage)<br />
                    <span className="text-cyan-600">封包密度: {grid.packet_count} pkts</span><br />
                    <span className="text-slate-500">最新收到: {grid.latest_time ? new Date(grid.latest_time.replace(' ', 'T') + 'Z').toLocaleString() : '--'}</span><br />
                    <span className="text-slate-500">平均 SNR: {grid.avg_snr?.toFixed(2)} dB</span>
                  </div>
                </Tooltip>
              </Rectangle>
            );
          }
          return null;
        })}

        {/* 2. 繪製最新 Traceroute 路徑 */}
        {showTraceroute && traceroutePath.length >= 2 && (
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
            {nodesWithGPS.map(node => {
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
                  eventHandlers={{ click: () => onSelectNode(node.node_id) }}
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
            })}
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

        {/* --- 動態 Hop 覆蓋模擬器 (Weighted Reachability Map) --- */}
        {showSimulator && simResultMap && simState && simState.sourceNodeId && (() => {
          const hopGroups = new Map<number, Node[]>();
          simResultMap.forEach((info, nodeId) => {
            if (!hopGroups.has(info.hop)) hopGroups.set(info.hop, []);
            const n = allNodes.find(n => n.node_id === nodeId) || nodes.find(n => n.node_id === nodeId);
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

      {/* 圖例 Legend Overlay */}
      <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur-sm p-3 rounded-xl shadow-xl z-[1000] border border-slate-200 pointer-events-auto min-w-[160px] transition-all duration-300">
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
                <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">分析圖層分析 Analytics</div>
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
export default NodeMap;