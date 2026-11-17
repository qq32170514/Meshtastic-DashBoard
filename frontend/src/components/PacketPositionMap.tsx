import React from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, CircleMarker, Popup } from 'react-leaflet';
import { AppTileLayer } from '../mapTiles';
import MapAutoResize from '../maps/MapAutoResize';
import { sanitizeCoordinatePair } from '../maps/coordUtils';

interface PacketPositionMapProps {
  lat: number;
  lon: number;
  darkMode: boolean;
}

const PacketPositionMap: React.FC<PacketPositionMapProps> = ({ lat, lon, darkMode }) => {
  const coords = sanitizeCoordinatePair(lat, lon);
  if (!coords) {
    return (
      <div className={`h-full flex items-center justify-center text-xs italic ${darkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'}`}>
        此封包座標格式無效或超出地理範圍，無法顯示地圖
      </div>
    );
  }

  return (
    <MapContainer
      key={`pos-map-${coords[0]}-${coords[1]}`}
      center={coords}
      zoom={13}
      style={{ height: '100%', width: '100%' }}
      zoomControl={false}
    >
      <AppTileLayer darkMode={darkMode} />
      <MapAutoResize points={[coords]} />
      <CircleMarker
        center={coords}
        radius={8}
        pathOptions={{ fillColor: '#22c55e', color: 'white', weight: 2, fillOpacity: 0.9 }}
      >
        <Popup>
          <div className="text-[11px] font-mono">
            {coords[0].toFixed(5)}, {coords[1].toFixed(5)}
          </div>
        </Popup>
      </CircleMarker>
    </MapContainer>
  );
};

export default PacketPositionMap;
