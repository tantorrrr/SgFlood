import { distanceM } from './geo.js';

// One-tap GPS reporting: pure decisions, no DOM/Leaflet.
export const GPS_OPTIONS = { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 };
export const GPS_ZOOM = 16;

// bbox = [south, west, north, east].
export function inBbox(bbox, lat, lng) {
  if (!bbox) return true;
  const [s, w, n, e] = bbox;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

const FALLBACK = {
  denied: 'Chưa cho phép định vị — hãy chạm lên bản đồ',
  unsupported: 'Trình duyệt không hỗ trợ định vị — hãy chạm lên bản đồ',
  timeout: 'Lấy vị trí quá lâu — hãy chạm lên bản đồ',
  error: 'Không lấy được vị trí — hãy chạm lên bản đồ',
  outside: 'Bạn đang ở ngoài vùng bản đồ — hãy chạm lên bản đồ',
};

// GeolocationPosition or GeolocationPositionError (code 1 denied, 3 timeout) → { fix } or { fallback, message }.
export function gpsDecision(result, bbox) {
  if (!result) return { fallback: 'unsupported', message: FALLBACK.unsupported };
  if (!result.coords) {
    const kind = result.code === 1 ? 'denied' : result.code === 3 ? 'timeout' : 'error';
    return { fallback: kind, message: FALLBACK[kind] };
  }
  const { latitude: lat, longitude: lng, accuracy } = result.coords;
  if (!inBbox(bbox, lat, lng)) return { fallback: 'outside', message: FALLBACK.outside };
  return { fix: { lat, lng, accuracyM: Math.round(accuracy ?? 0), at: result.timestamp ?? Date.now() } };
}

// Snapshot field: device fix → final reported point; null when no fix was used.
export function gpsMeta(fix, latlng) {
  if (!fix) return null;
  return {
    accuracyM: fix.accuracyM,
    distanceM: Math.round(distanceM([fix.lat, fix.lng], [latlng.lat, latlng.lng])),
    at: new Date(fix.at).toISOString(),
  };
}
