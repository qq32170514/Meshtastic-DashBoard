import React, { useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip as LeafletTooltip } from 'react-leaflet';

export interface NodeComparison {
  nodeId: string;
  nodeName: string;
  nodeShortName: string;
  nodeLat: number;
  nodeLng: number;
  nodeTemp: number | null;
  nodeHumidity: number | null;
  cwaStationId: string;
  cwaStationName: string;
  cwaCounty: string;
  cwaTown: string;
  cwaLat: number;
  cwaLng: number;
  cwaTemp: number;
  cwaHumidity: number | null;
  cwaWeather: string;
  distanceKm: number;
  deltaTemp: number | null;
  deltaHum: number | null;
  anomaly: boolean;
}

function fmt(v: number | null | undefined, dec = 1): string {
  if (v === null || v === undefined || isNaN(v)) return '--';
  return Number(v).toFixed(dec);
}

function getDeltaColor(dt: number | null): string {
  if (dt === null) return '#94a3b8';
  const abs = Math.abs(dt);
  if (abs >= 5) return '#ef4444';
  if (abs >= 3) return '#f97316';
  if (abs >= 1.5) return '#facc15';
  return '#22c55e';
}

function getWeatherIcon(weather: string): string {
  if (!weather) return '🌤️';
  if (weather.includes('晴')) return '☀️';
  if (weather.includes('雨')) return '🌧️';
  if (weather.includes('陰')) return '☁️';
  if (weather.includes('雲')) return '⛅';
  if (weather.includes('霧')) return '🌫️';
  return '🌡️';
}

interface CwaNodeMapProps {
  nodes: NodeComparison[];
  darkMode: boolean;
}

export default function CwaNodeMap({ nodes, darkMode }: CwaNodeMapProps) {
  const [showPillLabels, setShowPillLabels] = useState<boolean>(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (nodes.length === 0) {
    return <div className="text-center text-slate-500 py-16 font-mono">沒有有 GPS 座標且有氣溫遙測的節點</div>;
  }

  const centerLat = nodes.reduce((s, n) => s + n.nodeLat, 0) / nodes.length;
  const centerLng = nodes.reduce((s, n) => s + n.nodeLng, 0) / nodes.length;

  // 收集 unique CWA 氣象站
  const cwaStationMap = new Map<string, { id: string; name: string; county: string; town: string; lat: number; lng: number; temp: number; weather: string }>();
  nodes.forEach(n => {
    if (!cwaStationMap.has(n.cwaStationId)) {
      cwaStationMap.set(n.cwaStationId, {
        id: n.cwaStationId,
        name: n.cwaStationName,
        county: n.cwaCounty,
        town: n.cwaTown,
        lat: n.cwaLat,
        lng: n.cwaLng,
        temp: n.cwaTemp,
        weather: n.cwaWeather,
      });
    }
  });
  const uniqueCwaStations = Array.from(cwaStationMap.values());

  // 尋找最高 ΔT 的熱積累焦點節點
  const hottestNode = [...nodes].sort((a, b) => (b.deltaTemp ?? -99) - (a.deltaTemp ?? -99))[0];
  const validDeltas = nodes.map(n => n.deltaTemp).filter((d): d is number => d !== null);
  const avgDelta = validDeltas.length > 0 ? validDeltas.reduce((a, b) => a + b, 0) / validDeltas.length : null;

  const selectedNode = selectedNodeId ? nodes.find(n => n.nodeId === selectedNodeId) : null;

  return (
    <div className="space-y-3">
      {/* 頂部功能區與氣象圖例 */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>圖例：</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500"></span>ΔT &lt; 1.5°C 正常</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-400"></span>1.5–3°C 輕微偏高</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-orange-500"></span>3–5°C 偏高</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500"></span>≥ 5°C 嚴重過熱</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full border border-cyan-300 bg-cyan-500/30"></span>CWA 官方站</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPillLabels(!showPillLabels)}
            className={`px-2 py-0.5 rounded text-[9px] font-bold border transition-all ${
              showPillLabels
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            {showPillLabels ? '🏷️ 氣溫圖卡標籤：開啟' : '🏷️ 氣溫圖卡標籤：隱藏'}
          </button>
        </div>
      </div>

      {/* 主地圖容器（含懸浮氣象圖卡 HUD Overlay） */}
      <div className="relative rounded-2xl overflow-hidden border border-slate-800 shadow-2xl" style={{ height: '560px' }}>
        
        {/* ⛅ 氣象戰情懸浮 HUD 卡片 Overlay (Top-Left) */}
        <div className="absolute top-3 left-3 z-[1000] pointer-events-auto max-w-[280px] sm:max-w-xs">
          <div className="backdrop-blur-md bg-slate-900/85 border border-slate-700/80 p-3.5 rounded-2xl shadow-2xl space-y-2 text-slate-200">
            <div className="flex items-center justify-between border-b border-slate-700/60 pb-2">
              <div className="flex items-center gap-1.5 font-bold text-xs text-cyan-400">
                <span className="text-sm">⛅</span> CWA 氣象站實測比對戰情
              </div>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono">
                即時廣播
              </span>
            </div>

            {/* 統計數據 Chips */}
            <div className="grid grid-cols-3 gap-1.5 text-center font-mono text-[10px]">
              <div className="bg-slate-800/80 p-1.5 rounded-lg border border-slate-700/50">
                <div className="text-slate-400 text-[9px]">Mesh 節點</div>
                <div className="font-bold text-cyan-300 text-xs">{nodes.length}</div>
              </div>
              <div className="bg-slate-800/80 p-1.5 rounded-lg border border-slate-700/50">
                <div className="text-slate-400 text-[9px]">CWA 氣象站</div>
                <div className="font-bold text-blue-300 text-xs">{uniqueCwaStations.length}</div>
              </div>
              <div className="bg-slate-800/80 p-1.5 rounded-lg border border-slate-700/50">
                <div className="text-slate-400 text-[9px]">全網平均 ΔT</div>
                <div className={`font-bold text-xs ${avgDelta && avgDelta > 2 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {avgDelta !== null ? (avgDelta > 0 ? '+' : '') + fmt(avgDelta) + '°C' : '--'}
                </div>
              </div>
            </div>

            {/* 焦點過熱節點卡片 */}
            {hottestNode && hottestNode.deltaTemp && hottestNode.deltaTemp > 2.5 && (
              <div className="bg-gradient-to-r from-red-950/60 to-orange-950/40 p-2 rounded-xl border border-red-500/40 text-[10px] space-y-1">
                <div className="flex items-center justify-between text-red-300 font-bold">
                  <span>🔥 最高熱積累節點</span>
                  <span className="font-mono text-red-400">ΔT +{fmt(hottestNode.deltaTemp)}°C</span>
                </div>
                <div className="text-slate-300 flex items-center justify-between">
                  <span className="font-mono text-cyan-300 font-bold">{hottestNode.nodeName}</span>
                  <span className="font-mono">{fmt(hottestNode.nodeTemp)} °C</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 📌 被點選節點的氣象卡片 Overlay (Top-Right) */}
        {selectedNode && (
          <div className="absolute top-3 right-3 z-[1000] pointer-events-auto w-72 backdrop-blur-md bg-slate-900/90 border border-cyan-500/50 p-3.5 rounded-2xl shadow-2xl space-y-2 text-slate-100 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-700/60 pb-1.5">
              <div className="flex items-center gap-1.5 text-cyan-400 font-bold text-xs">
                <span>{getWeatherIcon(selectedNode.cwaWeather)}</span> {selectedNode.nodeName}
              </div>
              <button
                onClick={() => setSelectedNodeId(null)}
                className="text-slate-400 hover:text-white text-xs px-1"
              >✕</button>
            </div>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between items-center font-mono">
                <span className="text-slate-400">節點實測溫濕度</span>
                <span className="font-bold text-amber-400 text-xs">
                  {fmt(selectedNode.nodeTemp)} °C
                  {selectedNode.nodeHumidity != null && <span className="text-slate-400 font-normal"> / {fmt(selectedNode.nodeHumidity, 0)}%</span>}
                </span>
              </div>
              <div className="flex justify-between items-center font-mono">
                <span className="text-slate-400">配對 CWA 測站</span>
                <span className="text-blue-300 font-bold">{selectedNode.cwaStationName} ({fmt(selectedNode.distanceKm)} km)</span>
              </div>
              <div className="flex justify-between items-center font-mono">
                <span className="text-slate-400">官方測站氣溫</span>
                <span className="text-blue-400 font-bold">{fmt(selectedNode.cwaTemp)} °C</span>
              </div>
              
              {/* ΔT 對比條條形圖視效 */}
              <div className="pt-1.5 border-t border-slate-800">
                <div className="flex justify-between text-[10px] font-mono mb-1">
                  <span className="text-slate-400">溫度極差 ΔT</span>
                  <span className={`font-bold ${selectedNode.anomaly ? 'text-red-400' : 'text-emerald-400'}`}>
                    {selectedNode.deltaTemp != null ? (selectedNode.deltaTemp > 0 ? '+' : '') + fmt(selectedNode.deltaTemp) + ' °C' : '--'}
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden flex">
                  <div
                    className="bg-blue-500 h-full transition-all"
                    style={{ width: `${Math.min(100, Math.max(10, ((selectedNode.cwaTemp ?? 20) / 40) * 100))}%` }}
                    title="CWA 氣溫"
                  />
                  <div
                    className={`h-full transition-all ${selectedNode.anomaly ? 'bg-red-500' : 'bg-amber-400'}`}
                    style={{ width: `${Math.min(100, Math.max(10, ((selectedNode.nodeTemp ?? 20) / 40) * 100))}%` }}
                    title="Mesh 節點氣溫"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 🗺️ Leaflet 地圖主體 */}
        <MapContainer
          key={`cwa-map-v2-${nodes.length}`}
          center={[isNaN(centerLat) ? 23.8 : centerLat, isNaN(centerLng) ? 121 : centerLng]}
          zoom={9}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; OSM &copy; CARTO'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          {/* 連線：Mesh 節點 → 配對 CWA 站 */}
          {nodes.map(n => (
            <Polyline
              key={`conn-${n.nodeId}`}
              positions={[[n.nodeLat, n.nodeLng], [n.cwaLat, n.cwaLng]]}
              pathOptions={{
                color: getDeltaColor(n.deltaTemp),
                weight: n.anomaly ? 2 : 1.2,
                opacity: n.anomaly ? 0.75 : 0.4,
                dashArray: '4,6',
              }}
            />
          ))}

          {/* 🏛️ CWA 官方氣象站標記 */}
          {uniqueCwaStations.map(st => (
            <CircleMarker
              key={`cwa-${st.id}`}
              center={[st.lat, st.lng]}
              radius={8}
              pathOptions={{
                color: '#93c5fd',
                fillColor: '#2563eb',
                fillOpacity: 0.7,
                weight: 2,
              }}
            >
              <LeafletTooltip direction="top" offset={[0, -8]}>
                <div className="font-sans text-[11px] space-y-1 p-0.5">
                  <div className="font-bold text-blue-300 flex items-center gap-1">
                    <span>{getWeatherIcon(st.weather)}</span> CWA 氣象站 · {st.name}
                  </div>
                  <div className="text-slate-300 text-[10px]">{st.county} {st.town}</div>
                  <div className="font-mono text-cyan-300 font-bold text-xs">
                    官方氣溫：{fmt(st.temp)} °C
                  </div>
                </div>
              </LeafletTooltip>
            </CircleMarker>
          ))}

          {/* 📡 Mesh 節點標記（含動態天氣圖卡 Tooltip/Pills） */}
          {nodes.map(n => {
            const dtColor = getDeltaColor(n.deltaTemp);
            return (
              <CircleMarker
                key={`mesh-${n.nodeId}`}
                center={[n.nodeLat, n.nodeLng]}
                radius={n.anomaly ? 12 : 9}
                pathOptions={{
                  color: n.anomaly ? '#ef4444' : dtColor,
                  fillColor: dtColor,
                  fillOpacity: 0.9,
                  weight: n.anomaly ? 3 : 2,
                }}
                eventHandlers={{
                  click: () => setSelectedNodeId(n.nodeId),
                }}
              >
                {/* 常駐/懸浮 氣象圖卡標籤 */}
                <LeafletTooltip
                  direction="top"
                  permanent={showPillLabels}
                  offset={[0, -10]}
                >
                  <div className="font-sans text-[11px] p-1 space-y-1 max-w-[200px]">
                    <div className="flex items-center justify-between gap-2 border-b border-slate-700/50 pb-1">
                      <span className="font-bold text-cyan-300 font-mono text-[11px]">
                        📡 {n.nodeShortName || n.nodeName}
                      </span>
                      <span className="font-mono text-[11px] font-bold text-amber-300 bg-amber-950/40 px-1 rounded border border-amber-500/30">
                        {fmt(n.nodeTemp)}°C
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-300 font-mono">
                      <span>{n.cwaStationName} ({fmt(n.distanceKm)}km)</span>
                      <span className="text-blue-300 font-bold">{fmt(n.cwaTemp)}°C</span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] font-mono pt-0.5">
                      <span className="text-slate-400">溫差 ΔT</span>
                      <span
                        className="font-black px-1.5 py-0.2 rounded text-[10px]"
                        style={{ backgroundColor: `${dtColor}25`, color: dtColor }}
                      >
                        {n.deltaTemp != null ? (n.deltaTemp > 0 ? '+' : '') + fmt(n.deltaTemp) + '°C' : '--'}
                        {n.anomaly ? ' ⚠️' : ''}
                      </span>
                    </div>
                  </div>
                </LeafletTooltip>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      {/* 底部摘要統計 */}
      <div className="flex flex-wrap items-center justify-between gap-4 text-[10px] font-mono text-slate-400">
        <div>
          共 <span className="text-cyan-300 font-bold">{nodes.length}</span> 個 Mesh 節點已配對至 <span className="text-blue-300 font-bold">{uniqueCwaStations.length}</span> 個 CWA 氣象站
        </div>
        <div className="flex gap-3">
          <span className="text-red-400 font-bold">⚠️ 熱積累異常: {nodes.filter(n => n.anomaly).length} 個</span>
          <span className="text-green-400 font-bold">✓ 數據正常: {nodes.filter(n => !n.anomaly && n.deltaTemp !== null).length} 個</span>
        </div>
      </div>
    </div>
  );
}
