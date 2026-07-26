import React from 'react';
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

function getDeltaColor(dt: number | null): string {
  if (dt === null) return '#94a3b8';
  const abs = Math.abs(dt);
  if (abs >= 5) return '#ef4444';
  if (abs >= 3) return '#f97316';
  if (abs >= 1.5) return '#facc15';
  return '#22c55e';
}

interface CwaNodeMapProps {
  nodes: NodeComparison[];
  darkMode: boolean;
}

export default function CwaNodeMap({ nodes, darkMode }: CwaNodeMapProps) {
  if (nodes.length === 0) {
    return <div className="text-center text-slate-500 py-16">沒有有 GPS 座標且有溫度遙測的節點</div>;
  }

  const centerLat = nodes.reduce((s, n) => s + n.nodeLat, 0) / nodes.length;
  const centerLng = nodes.reduce((s, n) => s + n.nodeLng, 0) / nodes.length;

  const cwaStationMap = new Map<string, { id: string; name: string; county: string; town: string; lat: number; lng: number; temp: number; weather: string; }>();
  nodes.forEach(n => {
    if (!cwaStationMap.has(n.cwaStationId)) {
      cwaStationMap.set(n.cwaStationId, { id: n.cwaStationId, name: n.cwaStationName, county: n.cwaCounty, town: n.cwaTown, lat: n.cwaLat, lng: n.cwaLng, temp: n.cwaTemp, weather: n.cwaWeather });
    }
  });
  const uniqueCwaStations = Array.from(cwaStationMap.values());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono">
        <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>圖例：</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-green-500"></span>ΔT &lt; 1.5°C 正常</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-yellow-400"></span>1.5–3°C 輕微偏高</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-orange-500"></span>3–5°C 異常偏高</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-red-500"></span>≥ 5°C 嚴重過熱</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full border-2 border-blue-400" style={{ background: 'rgba(59,130,246,0.3)' }}></span>CWA 氣象站</span>
      </div>
      <div className="rounded-xl overflow-hidden" style={{ height: '540px', border: '1px solid #1e293b' }}>
        <MapContainer key={`cwa-map-${nodes.length}`} center={[isNaN(centerLat) ? 23.8 : centerLat, isNaN(centerLng) ? 121 : centerLng]} zoom={9} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution='&copy; OSM &copy; CARTO' url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
          {nodes.map(n => (<Polyline key={`conn-${n.nodeId}`} positions={[[n.nodeLat, n.nodeLng], [n.cwaLat, n.cwaLng]]} pathOptions={{ color: getDeltaColor(n.deltaTemp), weight: 1.5, opacity: 0.45, dashArray: '5,7' }} />))}
          {uniqueCwaStations.map(st => (
            <CircleMarker key={`cwa-${st.id}`} center={[st.lat, st.lng]} radius={7} pathOptions={{ color: '#93c5fd', fillColor: '#3b82f6', fillOpacity: 0.45, weight: 2 }}>
              <LeafletTooltip direction="top" offset={[0, -8]}>
                <div style={{ fontSize: '11px', lineHeight: '1.7' }}><strong>🌡️ {st.name}</strong><br />{st.county} {st.town}<br />官方氣溫：<strong>{st.temp} °C</strong><br />{st.weather && <span>天氣：{st.weather}</span>}</div>
              </LeafletTooltip>
            </CircleMarker>
          ))}
          {nodes.map(n => (
            <CircleMarker key={`mesh-${n.nodeId}`} center={[n.nodeLat, n.nodeLng]} radius={n.anomaly ? 11 : 8} pathOptions={{ color: n.anomaly ? '#ef4444' : getDeltaColor(n.deltaTemp), fillColor: getDeltaColor(n.deltaTemp), fillOpacity: 0.88, weight: n.anomaly ? 2.5 : 1.5 }}>
              <LeafletTooltip direction="top" sticky offset={[0, -6]}>
                <div style={{ fontSize: '11px', lineHeight: '1.8', minWidth: '190px' }}>
                  <strong style={{ color: '#22d3ee' }}>📡 {n.nodeName}</strong><br />
                  <span style={{ color: '#94a3b8', fontSize: '10px' }}>{n.nodeId}</span><br />
                  節點實測：<strong style={{ color: '#fbbf24' }}>{n.nodeTemp ?? '--'} °C</strong>{n.nodeHumidity != null ? <span style={{ color: '#94a3b8' }}> / {n.nodeHumidity}%</span> : null}<br />
                  比對站：{n.cwaStationName}<br />
                  <span style={{ color: '#94a3b8', fontSize: '10px' }}>{n.cwaCounty} {n.cwaTown} · {n.distanceKm} km</span><br />
                  官方氣溫：<strong style={{ color: '#60a5fa' }}>{n.cwaTemp} °C</strong><br />
                  <strong style={{ color: n.anomaly ? '#f87171' : n.deltaTemp != null && n.deltaTemp > 0 ? '#fb923c' : '#4ade80', fontSize: '12px' }}>
                    ΔT = {n.deltaTemp != null ? (n.deltaTemp > 0 ? '+' : '') + n.deltaTemp + ' °C' : '--'}{n.anomaly ? '  ⚠️ 異常過熱' : ''}
                  </strong>
                </div>
              </LeafletTooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div className="flex flex-wrap gap-4 text-[10px] font-mono">
        <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>共 {nodes.length} 個 Mesh 節點 · 配對 {uniqueCwaStations.length} 個 CWA 氣象站</span>
        <span className="text-red-400">⚠️ 異常節點 {nodes.filter(n => n.anomaly).length} 個</span>
        <span className="text-green-400">✓ 正常節點 {nodes.filter(n => !n.anomaly && n.deltaTemp !== null).length} 個</span>
      </div>
    </div>
  );
}
