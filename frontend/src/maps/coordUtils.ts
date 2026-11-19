// frontend/src/maps/coordUtils.ts
// Pure coordinate validation helpers (no Leaflet dependency so App.tsx can validate without loading Leaflet).

export type LatLngTuple = [number, number];

export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

export function sanitizeCoordinatePair(lat: unknown, lng: unknown): LatLngTuple | null {
  if (!isValidLatLng(lat, lng)) return null;
  return [lat, lng];
}

export function dedupeAdjacentPoints(points: LatLngTuple[]): LatLngTuple[] {
  const result: LatLngTuple[] = [];
  for (const pt of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
      result.push(pt);
    }
  }
  return result;
}

