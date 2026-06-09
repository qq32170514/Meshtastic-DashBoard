import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Node } from './App';
import { Info, ChevronDown, ChevronUp } from 'lucide-react';

// 修正 Leaflet 預設圖示路徑問題
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

// 顏色映射函數：根據 Role 返回對應顏色
const getRoleColor = (role?: string) => {
  switch (role?.toUpperCase()) {
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

  if (diffMinutes < 5)   return { filter: 'brightness(1.3) saturate(2)' };
  if (diffHours < 2)     return { filter: 'brightness(1.1) saturate(1.4)' };
  if (diffHours < 12)    return { filter: 'brightness(0.8) saturate(0.7)' };
  if (diffHours < 24)    return { filter: 'brightness(0.6) saturate(0.3)' };
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
  showTopology?: boolean;  // 新增：顯示拓撲圖層
  showUtilization?: boolean; // 新增：顯示利用率圖層
  neighbors?: any[];       // 新增：鄰居關係資料
  activeTab?: string;
}

const NodeMap = ({ nodes, allNodes = [], gateways = [], onSelectNode, onShowDetail, isDetailView = false, showTopology = false, showUtilization = false, neighbors = [], activeTab }: NodeMapProps) => {
  const [isLegendExpanded, setIsLegendExpanded] = useState(false);
  const nodesWithGPS = nodes.filter(n => n.latitude && n.longitude);

  const MapInvalidator = () => {
    const map = useMap();
    useEffect(() => {
      setTimeout(() => {
        map.invalidateSize();
      }, 100);
    }, [activeTab, map]);
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
      <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
      
      {/* 繪製主節點 */}
      {nodesWithGPS.map(node => (
        <Marker 
          key={node.node_id} 
          icon={createColoredIcon(node.role, node.last_seen)}
          position={[node.latitude!, node.longitude!]}
          eventHandlers={{ click: () => onSelectNode(node.node_id) }}
        >
          <Popup>
            <div className="font-sans p-1 flex flex-col gap-1 min-w-[140px]">
              {/* 1. Long Name */}
              <div className="font-bold text-slate-800 text-sm border-b border-slate-100 pb-1 mb-1">{node.long_name || 'Unknown'}</div>
              
              {/* 2. Short Name */}
              <div className="text-xs text-slate-600 flex justify-between gap-4">
                <span className="text-slate-400">Short:</span> <span className="font-bold">{node.short_name || '??'}</span>
              </div>

              {/* 3. ID */}
              <div className="text-xs text-slate-600 flex justify-between gap-4">
                <span className="text-slate-400">ID:</span>
                <button onClick={() => onShowDetail?.(node.node_id)} className="font-mono font-bold text-blue-600 hover:text-blue-800 hover:underline">{node.node_id}</button>
              </div>

              {/* 4. Role */}
              <div className="text-xs text-slate-600 flex justify-between items-center gap-4">
                <span className="text-slate-400">Role:</span>
                <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-bold uppercase border border-slate-200">{node.role || 'CLIENT'}</span>
              </div>

              {/* 5. Channel */}
              <div className="text-xs text-slate-600 flex justify-between gap-4">
                <span className="text-slate-400">Channel:</span>
                <span className="font-mono text-cyan-600 font-bold">
                  {(() => {
                    const rawChannel = node.channel || '';
                    const isInvalid = /^\d+$/.test(rawChannel) || ['c', 'json', 'e', 'stat', ''].includes(rawChannel);
                    const channelName = isInvalid ? (() => {
                        const parts = (node.last_topic || '').split('/');
                        return parts.find(p => !/^\d+$/.test(p) && !['msh', 'TW', 'c', 'json', 'e', 'stat', ''].includes(p) && !p.startsWith('!')) || '-';
                    })() : rawChannel;
                    return channelName === 'MediumFast' ? '⚡ ' + channelName : channelName;
                  })()}
                </span>
              </div>
            </div>
          </Popup>
        </Marker>
      ))}

      {/* 繪製網路拓撲圖層 (NeighborInfo Lines) */}
      {showTopology && neighbors.map((rel, idx) => {
        const source = nodes.find(n => n.node_id === rel.node_id);
        const target = nodes.find(n => n.node_id === rel.neighbor_id);
        if (source?.latitude && target?.latitude) {
          return (
            <Polyline 
              key={`topo-${idx}`}
              positions={[[source.latitude, source.longitude], [target.latitude, target.longitude]]}
              pathOptions={{ color: '#06b6d4', weight: Math.max(0.5, rel.snr / 2), opacity: 0.4, dashArray: '3, 6' }}
            />
          );
        }
        return null;
      })}

      {/* 繪製頻道利用率圖層 (Utilization Heat Rings) */}
      {showUtilization && nodesWithGPS.map(node => {
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
      {gatewayMarkers.map((gw: any) => {
        const hops = gw.hop_start - gw.hop_limit;
        return (
        <React.Fragment key={gw.gateway_id}>
          <CircleMarker
            center={[gw.latitude, gw.longitude]}
            radius={8}
            pathOptions={{ 
              fillColor: getRecencyColor(gw.last_seen), 
              color: '#fff', 
              weight: 2, 
              fillOpacity: 0.9 
            }}
          >
            <Popup>
              <div className="font-sans">
                <strong>Gateway: {gw.short_name || gw.gateway_id}</strong><br/>
                Hops: {hops}<br/>
                Packets: {gw.count}
              </div>
            </Popup>
          </CircleMarker>
          
          {/* 繪製連線 (如果主節點有 GPS) */}
          {isDetailView && nodesWithGPS[0] && (
            <Polyline 
              positions={[[nodesWithGPS[0].latitude!, nodesWithGPS[0].longitude!], [gw.latitude, gw.longitude]]}
              pathOptions={{ 
                color: getRecencyColor(gw.last_seen), 
                weight: Math.min(12, 2 + (gw.count / 5)), // 優化公式：每 5 個封包增加 1px，最大寬度 12px
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
      );})}
    </MapContainer>

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
      
      {isLegendExpanded && (
        <div className="space-y-3 mt-2 pt-2 border-t border-slate-100 overflow-y-auto max-h-[60vh]">
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
                  <path d="M12.5 0C5.596 0 0 5.596 0 12.5C0 21.875 12.5 41 12.5 41C12.5 41 25 21.875 25 12.5C25 5.596 19.404 0 12.5 0Z" fill="currentColor" stroke="white" strokeWidth="1.5"/>
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