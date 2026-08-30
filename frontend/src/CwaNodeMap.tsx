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

export interface RegionSummary {
  county: string;
  nodeCount: number;
  avgCwaTemp?: number | null;
  avgMeshTemp?: number | null;
  avgDeltaTemp: number | null;
  maxDeltaTemp: number | null;
  minDeltaTemp: number | null;
  avgCwaHum?: number | null;
  avgMeshHum?: number | null;
  avgDeltaHum: number | null;
  weather?: string;
  anomalyCount: number;
  anomalyRate: number;
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || isNaN(v)) return '--';
  return Number(v).toFixed(1);
}

function getDeltaColor(dt: number | null): string {
  if (dt === null) return '#94a3b8';
  const abs = Math.abs(dt);
  if (abs >= 5) return '#ef4444';
  if (abs >= 3) return '#f97316';
  if (abs >= 1.5) return '#facc15';
  return '#22c55e';
}

function getWeatherIcon(weather?: string): string {
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
  regionSummary?: RegionSummary[];
  darkMode: boolean;
}

export default function CwaNodeMap({ nodes, regionSummary = [], darkMode }: CwaNodeMapProps) {
  const [selectedCounty, setSelectedCounty] = useState<string | null>(null);

  if (nodes.length === 0) {
    return <div className="text-center text-slate-500 py-16 font-mono">沒有有 GPS 座標且有氣溫遙測的節點</div>;
  }

  const filteredNodes = selectedCounty
    ? nodes.filter(n => n.cwaCounty === selectedCounty)
    : nodes;

  const centerLat = (filteredNodes.length > 0 ? filteredNodes : nodes).reduce((s, n) => s + n.nodeLat, 0) / (filteredNodes.length || 1);
  const centerLng = (filteredNodes.length > 0 ? filteredNodes : nodes).reduce((s, n) => s + n.nodeLng, 0) / (filteredNodes.length || 1);

  const cwaStationMap = new Map<string, { id: string; name: string; county: string; town: string; lat: number; lng: number; temp: number; humidity: number | null; weather: string }>();
  filteredNodes.forEach(n => {
    if (!cwaStationMap.has(n.cwaStationId)) {
      cwaStationMap.set(n.cwaStationId, {
        id: n.cwaStationId,
        name: n.cwaStationName,
        county: n.cwaCounty,
        town: n.cwaTown,
        lat: n.cwaLat,
        lng: n.cwaLng,
        temp: n.cwaTemp,
        humidity: n.cwaHumidity,
        weather: n.cwaWeather,
      });
    }
  });
  const uniqueCwaStations = Array.from(cwaStationMap.values());

  const countyCards = React.useMemo(() => {
    const map = new Map<string, { county: string; list: NodeComparison[] }>();
    nodes.forEach(n => {
      const c = n.cwaCounty || '未知縣市';
      if (!map.has(c)) map.set(c, { county: c, list: [] });
      map.get(c)!.list.push(n);
    });

    return Array.from(map.values()).map(({ county, list }) => {
      const reg = regionSummary.find(r => r.county === county);

      const validMeshTemps = list.map(x => x.nodeTemp).filter((t): t is number => t !== null && !isNaN(t));
      const validCwaTemps = list.map(x => x.cwaTemp).filter((t): t is number => t !== null && !isNaN(t));
      const validDeltas = list.map(x => x.deltaTemp).filter((d): d is number => d !== null && !isNaN(d));

      const validMeshHums = list.map(x => x.nodeHumidity).filter((h): h is number => h !== null && !isNaN(h));
      const validCwaHums = list.map(x => x.cwaHumidity).filter((h): h is number => h !== null && !isNaN(h));
      const validDeltaHums = list.map(x => x.deltaHum).filter((dh): dh is number => dh !== null && !isNaN(dh));

      const avgMeshTemp = reg?.avgMeshTemp ?? (validMeshTemps.length > 0 ? validMeshTemps.reduce((a, b) => a + b, 0) / validMeshTemps.length : null);
      const avgCwaTemp = reg?.avgCwaTemp ?? (validCwaTemps.length > 0 ? validCwaTemps.reduce((a, b) => a + b, 0) / validCwaTemps.length : null);
      const avgDeltaTemp = reg?.avgDeltaTemp ?? (validDeltas.length > 0 ? validDeltas.reduce((a, b) => a + b, 0) / validDeltas.length : null);

      const avgMeshHum = validMeshHums.length > 0 ? validMeshHums.reduce((a, b) => a + b, 0) / validMeshHums.length : null;
      const avgCwaHum = validCwaHums.length > 0 ? validCwaHums.reduce((a, b) => a + b, 0) / validCwaHums.length : null;
      const avgDeltaHum = reg?.avgDeltaHum ?? (validDeltaHums.length > 0 ? validDeltaHums.reduce((a, b) => a + b, 0) / validDeltaHums.length : null);

      const anomalyCount = list.filter(x => x.anomaly).length;
      const weather = reg?.weather || list.find(x => x.cwaWeather)?.cwaWeather || '晴';

      return {
        county,
        nodeCount: list.length,
        avgMeshTemp,
        avgCwaTemp,
        avgDeltaTemp,
        avgMeshHum,
        avgCwaHum,
        avgDeltaHum,
        maxDeltaTemp: validDeltas.length > 0 ? Math.max(...validDeltas) : null,
        minDeltaTemp: validDeltas.length > 0 ? Math.min(...validDeltas) : null,
        weather,
        anomalyCount,
        anomalyRate: Math.round((anomalyCount / list.length) * 100),
      };
    }).sort((a, b) => b.nodeCount - a.nodeCount);
  }, [nodes, regionSummary]);

  return (
    <div className="space-y-4">
      {/* 🏙️ 各縣市氣象與溫濕度對比圖卡專區 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
            <span className="text-sm">⛅</span> 各縣市氣象與溫濕度戰情圖卡
            <span className="text-[10px] font-mono text-slate-500">（點擊圖卡可篩選地圖）</span>
          </div>
          {selectedCounty && (
            <button
              onClick={() => setSelectedCounty(null)}
              className="text-[10px] text-cyan-400 hover:text-cyan-300 font-mono underline"
            >
              顯示全部縣市 ({nodes.length} 個節點)
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {countyCards.map((card) => {
            const isSelected = selectedCounty === card.county;
            const dtColor = getDeltaColor(card.avgDeltaTemp);
            return (
              <div
                key={card.county}
                onClick={() => setSelectedCounty(isSelected ? null : card.county)}
                className={`cursor-pointer rounded-2xl p-3.5 border transition-all duration-200 shadow-md ${
                  isSelected
                    ? 'bg-cyan-950/40 border-cyan-400 ring-2 ring-cyan-400/30 scale-[1.02]'
                    : darkMode
                    ? 'bg-slate-800/60 border-slate-700/60 hover:border-slate-500 hover:bg-slate-800'
                    : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-lg'
                }`}
              >
                {/* 圖卡標題 */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 font-bold text-sm text-slate-200">
                    <span className="text-base">{getWeatherIcon(card.weather)}</span>
                    <span>{card.county}</span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-700/60 text-cyan-300">
                    {card.nodeCount} 節點
                  </span>
                </div>

                {/* 氣溫與濕度數據比較 */}
                <div className="space-y-1.5 text-xs font-mono">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400 text-[11px]">Mesh 節點均溫/濕</span>
                    <span className="font-bold text-amber-400">
                      {fmt(card.avgMeshTemp)}°C
                      {card.avgMeshHum != null && <span className="text-cyan-300 font-normal"> / {fmt(card.avgMeshHum)}%</span>}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400 text-[11px]">CWA 官方氣溫/濕</span>
                    <span className="font-bold text-blue-400">
                      {fmt(card.avgCwaTemp)}°C
                      {card.avgCwaHum != null && <span className="text-blue-300 font-normal"> / {fmt(card.avgCwaHum)}%</span>}
                    </span>
                  </div>

                  {/* 區域 ΔT 與 ΔH 標籤 */}
                  <div className="flex justify-between items-center pt-1 border-t border-slate-700/40">
                    <span className="text-slate-400 text-[11px]">平均 ΔT / ΔH</span>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="font-black px-1.5 py-0.5 rounded text-[11px]"
                        style={{ backgroundColor: `${dtColor}20`, color: dtColor }}
                      >
                        {card.avgDeltaTemp !== null ? (card.avgDeltaTemp > 0 ? '+' : '') + fmt(card.avgDeltaTemp) + '°C' : '--'}
                      </span>
                      {card.avgDeltaHum != null && (
                        <span className="text-cyan-400 font-bold text-[10px]">
                          ΔH {card.avgDeltaHum > 0 ? '+' : ''}{fmt(card.avgDeltaHum)}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* 狀態提醒 */}
                <div className="mt-2.5 pt-2 border-t border-slate-700/30 flex items-center justify-between text-[10px]">
                  {card.anomalyCount > 0 ? (
                    <span className="text-red-400 font-bold flex items-center gap-1">
                      ⚠️ {card.anomalyCount} 個節點過熱
                    </span>
                  ) : (
                    <span className="text-emerald-400 font-medium flex items-center gap-1">
                      ✓ 數據比對良好
                    </span>
                  )}
                  <span className="text-slate-500 font-mono text-[9px]">
                    {card.weather || '晴'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 🗺️ 配對地圖 (含圖例懸浮地圖上方) */}
      <div className="relative rounded-2xl overflow-hidden border border-slate-800 shadow-xl" style={{ height: '520px' }}>
        
        {/* 📍 地圖圖例 (Overlay 放置於地圖右上角，與 NodeMap 一致) */}
        <div className="absolute top-3 right-3 z-[1000] pointer-events-auto backdrop-blur-md bg-slate-900/85 border border-slate-700/80 p-2.5 rounded-xl shadow-2xl text-[10px] font-mono text-slate-300 space-y-1">
          <div className="font-bold text-cyan-400 text-[11px] mb-1">🗺️ CWA 配對圖例</div>
          <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500"></span>ΔT &lt; 1.5°C 正常</div>
          <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-400"></span>1.5–3°C 偏高</div>
          <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-orange-500"></span>3–5°C 異常偏高</div>
          <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500"></span>≥ 5°C 嚴重過熱</div>
          <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-blue-400" style={{ background: 'rgba(59,130,246,0.3)' }}></span>CWA 官方氣象站</div>
          {selectedCounty && (
            <div className="pt-1 border-t border-slate-700 text-cyan-300 font-bold">
              篩選: {selectedCounty}
            </div>
          )}
        </div>

        <MapContainer
          key={`cwa-map-${selectedCounty || 'all'}-${filteredNodes.length}`}
          center={[isNaN(centerLat) ? 23.8 : centerLat, isNaN(centerLng) ? 121 : centerLng]}
          zoom={selectedCounty ? 11 : 9}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* 連線：Mesh 節點 → 配對 CWA 站 */}
          {filteredNodes.map(n => (
            <Polyline
              key={`conn-${n.nodeId}`}
              positions={[[n.nodeLat, n.nodeLng], [n.cwaLat, n.cwaLng]]}
              pathOptions={{
                color: getDeltaColor(n.deltaTemp),
                weight: 1.5,
                opacity: 0.5,
                dashArray: '5,7',
              }}
            />
          ))}

          {/* CWA 氣象站 */}
          {uniqueCwaStations.map(st => (
            <CircleMarker
              key={`cwa-${st.id}`}
              center={[st.lat, st.lng]}
              radius={8}
              pathOptions={{
                color: '#93c5fd',
                fillColor: '#3b82f6',
                fillOpacity: 0.5,
                weight: 2,
              }}
            >
              <LeafletTooltip direction="top" offset={[0, -8]}>
                <div style={{ fontSize: '11px', lineHeight: '1.7' }}>
                  <strong>🌡️ CWA {st.name} 氣象站</strong><br />
                  {st.county} {st.town}<br />
                  官方氣溫：<strong>{fmt(st.temp)} °C</strong>
                  {st.humidity != null && <span className="text-cyan-300"> / {fmt(st.humidity)}%</span>}<br />
                  {st.weather && <span>天氣：{st.weather}</span>}
                </div>
              </LeafletTooltip>
            </CircleMarker>
          ))}

          {/* Mesh 節點 */}
          {filteredNodes.map(n => (
            <CircleMarker
              key={`mesh-${n.nodeId}`}
              center={[n.nodeLat, n.nodeLng]}
              radius={n.anomaly ? 11 : 8}
              pathOptions={{
                color: n.anomaly ? '#ef4444' : getDeltaColor(n.deltaTemp),
                fillColor: getDeltaColor(n.deltaTemp),
                fillOpacity: 0.88,
                weight: n.anomaly ? 2.5 : 1.5,
              }}
            >
              <LeafletTooltip direction="top" sticky offset={[0, -6]}>
                <div style={{ fontSize: '11px', lineHeight: '1.8', minWidth: '200px' }}>
                  <strong style={{ color: '#22d3ee' }}>📡 {n.nodeName}</strong><br />
                  <span style={{ color: '#94a3b8', fontSize: '10px' }}>{n.nodeId}</span><br />
                  節點實測：<strong style={{ color: '#fbbf24' }}>{fmt(n.nodeTemp)} °C</strong>
                  {n.nodeHumidity != null ? <span style={{ color: '#22d3ee' }}> / {fmt(n.nodeHumidity)}% RH</span> : null}<br />
                  比對站：{n.cwaStationName} ({fmt(n.distanceKm)} km)<br />
                  官方：<strong style={{ color: '#60a5fa' }}>{fmt(n.cwaTemp)} °C</strong>
                  {n.cwaHumidity != null ? <span style={{ color: '#60a5fa' }}> / {fmt(n.cwaHumidity)}% RH</span> : null}<br />
                  <strong style={{ color: n.anomaly ? '#f87171' : n.deltaTemp != null && n.deltaTemp > 0 ? '#fb923c' : '#4ade80', fontSize: '12px' }}>
                    ΔT = {n.deltaTemp != null ? (n.deltaTemp > 0 ? '+' : '') + fmt(n.deltaTemp) + ' °C' : '--'}
                    {n.deltaHum != null ? ` · ΔH ${n.deltaHum > 0 ? '+' : ''}${fmt(n.deltaHum)}%` : ''}
                    {n.anomaly ? '  ⚠️ 異常過熱' : ''}
                  </strong>
                </div>
              </LeafletTooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      {/* 底部摘要統計 */}
      <div className="flex flex-wrap gap-4 text-[10px] font-mono text-slate-400">
        <span>共 {nodes.length} 個 Mesh 節點 · 配對 {uniqueCwaStations.length} 個 CWA 氣象站</span>
        <span className="text-red-400">⚠️ 異常節點 {nodes.filter(n => n.anomaly).length} 個</span>
        <span className="text-green-400">✓ 正常節點 {nodes.filter(n => !n.anomaly && n.deltaTemp !== null).length} 個</span>
      </div>
    </div>
  );
}
