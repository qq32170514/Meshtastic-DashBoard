import React from 'react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Node } from './App';
import { Info } from 'lucide-react';

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

// 建立自定義彩色圖標 (SVG 渲染)
const createColoredIcon = (role?: string) => {
  const color = getRoleColor(role);
  return L.divIcon({
    html: `
      <svg width="25" height="41" viewBox="0 0 25 41" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.4));">
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

// 顏色映射函數：跳數越少，顏色越深
const getHopColor = (hopStart?: number, hopLimit?: number) => {
  const hops = (hopStart || 0) - (hopLimit || 0);
  if (hops <= 0) return '#1e3a8a'; // 0跳 (深藍色)
  if (hops === 1) return '#3b82f6'; // 1跳 (藍色)
  if (hops === 2) return '#60a5fa'; // 2跳 (淺藍色)
  return '#bfdbfe'; // 3跳以上 (極淺藍)
};

interface NodeMapProps {
  nodes: Node[];
  allNodes?: Node[];      // 新增：所有節點資料，用於查找 Gateway 座標
  gateways?: any[];       // 新增：目前節點關聯的閘道統計
  onSelectNode: (id: string) => void;
  onShowDetail?: (id: string) => void; // 新增：顯示漂浮詳情頁的回呼
}

const NodeMap = ({ nodes, allNodes = [], gateways = [], onSelectNode, onShowDetail }: NodeMapProps) => {
  const nodesWithGPS = nodes.filter(n => n.latitude && n.longitude);
  
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
      <MapContainer center={[23.6, 121]} zoom={7} style={{ height: '100%', width: '100%' }}>
      <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
      
      {/* 繪製主節點 */}
      {nodesWithGPS.map(node => (
        <Marker 
          key={node.node_id} 
          icon={createColoredIcon(node.role)}
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
                    if (!node.last_topic) return '-';
                    const parts = node.last_topic.split('/');
                    return parts.length >= 5 ? parts[4] : (parts[2] || '-');
                  })()}
                </span>
              </div>
            </div>
          </Popup>
        </Marker>
      ))}

      {/* 繪製 Gateway 節點 (圓點表示) */}
      {gatewayMarkers.map((gw: any) => (
        <React.Fragment key={gw.gateway_id}>
          <CircleMarker
            center={[gw.latitude, gw.longitude]}
            radius={8}
            pathOptions={{ 
              fillColor: getHopColor(gw.hop_start, gw.hop_limit), 
              color: '#fff', 
              weight: 2, 
              fillOpacity: 0.9 
            }}
          >
            <Popup>
              <div className="font-sans">
                <strong>Gateway: {gw.short_name || gw.gateway_id}</strong><br/>
                Hops: {gw.hop_start - gw.hop_limit}<br/>
                Packets: {gw.count}
              </div>
            </Popup>
          </CircleMarker>
          
          {/* 繪製連線 (如果主節點有 GPS) */}
          {nodesWithGPS[0] && (
            <Polyline 
              positions={[[nodesWithGPS[0].latitude!, nodesWithGPS[0].longitude!], [gw.latitude, gw.longitude]]}
              pathOptions={{ color: getHopColor(gw.hop_start, gw.hop_limit), weight: 1, dashArray: '5, 5', opacity: 0.5 }}
            />
          )}
        </React.Fragment>
      ))}
    </MapContainer>

    {/* 圖例 Legend Overlay */}
    <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur-sm p-3 rounded-xl shadow-xl z-[1000] border border-slate-200 pointer-events-none min-w-[140px]">
      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-100 pb-1 flex items-center gap-1">
        <Info size={12} /> 地圖圖例 Legend
      </h4>
      
      <div className="space-y-3">
        {/* 角色分組 */}
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
              <span className="w-2.5 h-2.5 rounded-full bg-[#9333ea]"></span> REPEATER (紫)
            </div>
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-[#2563eb]"></span> CLIENT (藍)
            </div>
          </div>
        </div>

        {/* 跳數分組 */}
        <div className="pt-1 border-t border-slate-100">
          <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">閘道跳數 Hops</div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-[#1e3a8a]"></span> 0 跳 (最深)
            </div>
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-[#3b82f6]"></span> 1 跳
            </div>
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-[#60a5fa]"></span> 2 跳
            </div>
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-[#bfdbfe]"></span> 3+ 跳 (最淺)
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
};
export default NodeMap;