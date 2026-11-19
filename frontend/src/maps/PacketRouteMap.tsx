import React, { useMemo } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, CircleMarker, Polyline, Popup } from 'react-leaflet';
import { AppTileLayer } from '../mapTiles';
import MapAutoResize from './MapAutoResize';
import { dedupeAdjacentPoints, sanitizeCoordinatePair, type LatLngTuple } from './coordUtils';

export interface PacketRouteNodeInfo {
  nodeId: string;
  displayName?: string;
  latitude?: number | null;
  longitude?: number | null;
}

interface PacketRouteMapProps {
  mapKey: string;
  darkMode: boolean;
  sender: PacketRouteNodeInfo;
  lastHop?: PacketRouteNodeInfo | null;
  gateway: PacketRouteNodeInfo;
  hops: number;
  isMultiHop: boolean;
}

const PacketRouteMap: React.FC<PacketRouteMapProps> = ({
  mapKey,
  darkMode,
  sender,
  lastHop,
  gateway,
  hops,
  isMultiHop
}) => {
  const senderCoords = useMemo(
    () => sanitizeCoordinatePair(sender.latitude, sender.longitude),
    [sender.latitude, sender.longitude]
  );
  const lastHopCoords = useMemo(
    () => (lastHop ? sanitizeCoordinatePair(lastHop.latitude, lastHop.longitude) : null),
    [lastHop]
  );
  const gwCoords = useMemo(
    () => sanitizeCoordinatePair(gateway.latitude, gateway.longitude),
    [gateway.latitude, gateway.longitude]
  );

  const validCoords = useMemo(() => {
    const list: LatLngTuple[] = [];
    if (senderCoords) list.push(senderCoords);
    if (lastHopCoords) list.push(lastHopCoords);
    if (gwCoords) list.push(gwCoords);
    return dedupeAdjacentPoints(list);
  }, [senderCoords, lastHopCoords, gwCoords]);

  if (validCoords.length === 0) {
    return (
      <div className={`p-4 rounded-xl text-center text-[10px] italic border border-dashed ${darkMode ? 'border-slate-800 text-slate-500 bg-slate-900/50' : 'border-slate-300 text-slate-400 bg-slate-100/50'}`}>
        發送節點或 Gateway 尚未回報有效 GPS 定位座標，無法繪製地理路徑連線。
      </div>
    );
  }

  return (
    <div className="h-48 rounded-xl overflow-hidden border border-slate-300 dark:border-slate-700 shadow-inner">
      <MapContainer
        key={mapKey}
        center={validCoords[0]}
        zoom={11}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <AppTileLayer darkMode={darkMode} />
        <MapAutoResize points={validCoords} />

        {senderCoords && (
          <CircleMarker
            center={senderCoords}
            radius={7}
            pathOptions={{ fillColor: '#3b82f6', color: '#ffffff', weight: 2, fillOpacity: 0.95 }}
          >
            <Popup>
              <div className="text-[11px] font-sans">
                <span className="text-blue-500 font-bold block mb-0.5">發送節點 (Sender)</span>
                <strong>{sender.displayName || sender.nodeId}</strong>
                <div className="text-[9px] text-slate-500 font-mono mt-0.5">ID: {sender.nodeId}</div>
              </div>
            </Popup>
          </CircleMarker>
        )}

        {lastHopCoords && lastHop && (
          <CircleMarker
            center={lastHopCoords}
            radius={7}
            pathOptions={{ fillColor: '#f59e0b', color: '#ffffff', weight: 2, fillOpacity: 0.95 }}
          >
            <Popup>
              <div className="text-[11px] font-sans">
                <span className="text-amber-500 font-bold block mb-0.5">最後傳跳節點 (Last Relay Hop)</span>
                <strong>{lastHop.displayName || lastHop.nodeId}</strong>
                <div className="text-[9px] text-slate-500 font-mono mt-0.5">ID: {lastHop.nodeId}</div>
                <div className="text-[9px] text-amber-600 font-bold mt-0.5">多跳傳輸 ({hops} 跳)</div>
              </div>
            </Popup>
          </CircleMarker>
        )}

        {gwCoords && (
          <CircleMarker
            center={gwCoords}
            radius={7}
            pathOptions={{ fillColor: '#10b981', color: '#ffffff', weight: 2, fillOpacity: 0.95 }}
          >
            <Popup>
              <div className="text-[11px] font-sans">
                <span className="text-emerald-500 font-bold block mb-0.5">接收閘道器 (Gateway)</span>
                <strong>{gateway.displayName || gateway.nodeId}</strong>
                <div className="text-[9px] text-slate-500 font-mono mt-0.5">ID: {gateway.nodeId}</div>
              </div>
            </Popup>
          </CircleMarker>
        )}

        {lastHopCoords && (
          <>
            {senderCoords && (senderCoords[0] !== lastHopCoords[0] || senderCoords[1] !== lastHopCoords[1]) && (
              <Polyline
                positions={[senderCoords, lastHopCoords]}
                color="#f59e0b"
                weight={2.5}
                dashArray="4, 4"
              />
            )}
            {gwCoords && (lastHopCoords[0] !== gwCoords[0] || lastHopCoords[1] !== gwCoords[1]) && (
              <Polyline
                positions={[lastHopCoords, gwCoords]}
                color="#10b981"
                weight={3}
              />
            )}
          </>
        )}

        {!lastHopCoords && senderCoords && gwCoords && (senderCoords[0] !== gwCoords[0] || senderCoords[1] !== gwCoords[1]) && (
          <Polyline
            positions={[senderCoords, gwCoords]}
            color={isMultiHop ? '#f59e0b' : '#10b981'}
            weight={2.5}
            dashArray={isMultiHop ? '5, 5' : undefined}
          />
        )}
      </MapContainer>
    </div>
  );
};

export default PacketRouteMap;

