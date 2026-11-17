import React, { useMemo } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, CircleMarker, Polyline, Popup } from 'react-leaflet';
import { AppTileLayer } from '../mapTiles';
import MapAutoResize from './MapAutoResize';
import { dedupeAdjacentPoints, sanitizeCoordinatePair, type LatLngTuple } from './coordUtils';

export interface TracerouteMapHop {
  nodeId: string;
  label?: string;
  latitude?: number | null;
  longitude?: number | null;
  snr?: number | null;
}

interface TracerouteMapProps {
  hops: TracerouteMapHop[];
  darkMode: boolean;
}

const TracerouteMap: React.FC<TracerouteMapProps> = ({ hops, darkMode }) => {
  const validHops = useMemo(() => {
    const out: Array<{ hop: TracerouteMapHop; coords: LatLngTuple }> = [];
    for (const hop of hops) {
      const pair = sanitizeCoordinatePair(hop.latitude, hop.longitude);
      if (pair) {
        out.push({ hop, coords: pair });
      }
    }
    return out;
  }, [hops]);

  const points = useMemo(() => validHops.map((v) => v.coords), [validHops]);
  const linePoints = useMemo(() => dedupeAdjacentPoints(points), [points]);

  if (linePoints.length < 2) {
    return (
      <div className={`p-4 rounded-xl text-center text-[10px] italic ${darkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'}`}>
        無法顯示地圖：來源或目的地節點缺少有效 GPS 座標
      </div>
    );
  }

  return (
    <div className="h-48 rounded-xl overflow-hidden border border-slate-300 dark:border-slate-700">
      <MapContainer
        key={`traceroute-map-${linePoints.map((p) => p.join(',')).join('|')}`}
        center={linePoints[0]}
        zoom={10}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <AppTileLayer darkMode={darkMode} />
        <MapAutoResize points={linePoints} />
        {validHops.map(({ hop, coords }, idx) => (
          <CircleMarker
            key={`${hop.nodeId}-${idx}`}
            center={coords}
            radius={6}
            pathOptions={{
              fillColor: idx === 0 ? '#eab308' : idx === validHops.length - 1 ? '#ef4444' : '#3b82f6',
              color: 'white',
              weight: 2,
              fillOpacity: 1
            }}
          >
            <Popup>
              <div className="text-[11px] font-sans">
                <div className="font-bold">{hop.label || hop.nodeId}</div>
                <div className="text-[9px] font-mono text-slate-500">ID: {hop.nodeId} (Hop #{idx + 1})</div>
                {typeof hop.snr === 'number' && Number.isFinite(hop.snr) && (
                  <div className="text-[9px] text-cyan-600 font-bold">SNR: {hop.snr} dB</div>
                )}
              </div>
            </Popup>
          </CircleMarker>
        ))}
        <Polyline positions={linePoints} color="#eab308" weight={3} dashArray="5, 5" />
      </MapContainer>
    </div>
  );
};

export default TracerouteMap;

