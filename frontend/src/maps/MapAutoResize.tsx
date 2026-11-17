import React, { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import type { LatLngTuple } from './coordUtils';

interface MapAutoResizeProps {
  points?: LatLngTuple[];
}

/**
 * Ensures Leaflet recalculates container dimensions when mounted inside modals/tabs
 * and on window resize, without polling intervals.
 */
const MapAutoResize: React.FC<MapAutoResizeProps> = ({ points }) => {
  const map = useMap();

  useEffect(() => {
    let rafId = requestAnimationFrame(() => {
      try {
        map.invalidateSize();
      } catch (_) {}
    });
    const timerId = window.setTimeout(() => {
      try {
        map.invalidateSize();
        if (points && points.length >= 2) {
          map.fitBounds(points, { padding: [24, 24], maxZoom: 13, animate: false });
        }
      } catch (_) {}
    }, 120);

    const onResize = () => {
      try {
        map.invalidateSize();
      } catch (_) {}
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      window.removeEventListener('resize', onResize);
    };
  }, [map, points]);

  return null;
};

export default MapAutoResize;

