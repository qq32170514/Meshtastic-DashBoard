import React from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, CircleMarker } from 'react-leaflet';
import { AppTileLayer } from '../mapTiles';

interface PacketPositionMapProps {
  lat: number;
  lon: number;
  darkMode: boolean;
}

const PacketPositionMap: React.FC<PacketPositionMapProps> = ({ lat, lon, darkMode }) => {
  return (
    <MapContainer
      key={`pos-map-${lat}-${lon}`}
      center={[lat, lon]}
      zoom={13}
      style={{ height: '100%', width: '100%' }}
      zoomControl={false}
    >
      <AppTileLayer darkMode={darkMode} />
      <CircleMarker
        center={[lat, lon]}
        radius={8}
        pathOptions={{ fillColor: '#22c55e', color: 'white', weight: 2, fillOpacity: 0.9 }}
      />
    </MapContainer>
  );
};

export default PacketPositionMap;

