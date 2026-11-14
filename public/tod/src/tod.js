'use strict';

const IS_NODE = typeof module !== 'undefined' && module.exports;

const VALID_STATUSES = ['approved', 'planned', 'estimated'];
const EARTH_RADIUS_M = 6371008.8;

function loadData(dir) {
  const fs = require('fs');
  const path = require('path');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return {
    lines: read('metro-lines.geojson'),
    zones: read('tod-zones.geojson'),
  };
}

function haversine(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// rings[0] is the outer ring, the rest are holes
function inPolygon(lon, lat, rings) {
  if (!inRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i])) return false;
  }
  return true;
}

function lookup(lon, lat, data) {
  const matches = [];
  for (const f of data.zones.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (polys.some((p) => inPolygon(lon, lat, p))) {
      const p = f.properties;
      const m = { kind: p.kind, line: p.line, station: p.station, status: p.status, source: p.source };
      if (p.name) m.name = p.name;
      matches.push(m);
    }
  }
  let nearestStation = null;
  for (const f of data.lines.features) {
    if (f.properties.type !== 'station') continue;
    const [sx, sy] = f.geometry.coordinates;
    const d = haversine(lon, lat, sx, sy);
    if (!nearestStation || d < nearestStation.distance_m) {
      nearestStation = { line: f.properties.line, name: f.properties.name, distance_m: d };
    }
  }
  return { matches, nearestStation };
}

// most specific first: core > next > radius > corridor
const CATEGORY_ORDER = ['core', 'next', 'radius', 'corridor'];

// same labels as the map legend in src/map.js
const CATEGORY_LABELS = {
  core: 'Lõi TOD',
  next: 'Vùng giáp ranh TOD',
  radius: 'Bán kính TOD',
  corridor: 'Hành lang ảnh hưởng tuyến',
};

const STATUS_LABELS = {
  approved: 'đã phê duyệt',
  planned: 'quy hoạch',
  estimated: 'ước tính',
};

const COORD_RE = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)([+-]?\d+(?:\.\d+)?)\s*$/;

function validLatLon(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// 'lat, lon' or 'lat lon' in decimal degrees -> {lat, lon} or null
function parseCoords(text) {
  if (typeof text !== 'string') return null;
  const m = COORD_RE.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return validLatLon(lat, lon) ? { lat, lon } : null;
}

function formatMeters(d) {
  return String(Math.round(d)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' m';
}

function describeSource(source) {
  if (!source || !source.url) return 'Nguồn: không có.';
  const extra = [];
  if (source.decision) extra.push('Quyết định ' + source.decision);
  if (source.date) extra.push('ngày ' + source.date);
  return 'Nguồn: ' + source.url + (extra.length ? ' (' + extra.join(', ') + ')' : '') + '.';
}

function describeStatus(status) {
  const label = STATUS_LABELS[status];
  return 'Trạng thái: ' + (label ? label + ' (' + status + ')' : 'không rõ') + '.';
}

function errorResult(error, text) {
  return { category: 'none', error, text, nearest: null };
}

function hasFeatures(fc) {
  return !!fc && Array.isArray(fc.features);
}

function stationsOf(data) {
  return data.lines.features.filter((f) =>
    f && f.properties && f.properties.type === 'station' && f.geometry && f.geometry.type === 'Point');
}

function nearestOf(lon, lat, stations) {
  let best = null;
  for (const f of stations) {
    const [sx, sy] = f.geometry.coordinates;
    const d = haversine(lon, lat, sx, sy);
    if (!best || d < best.distance_m) {
      best = { line: f.properties.line, station: f.properties.name, distance_m: d, feature: f };
    }
  }
  return best;
}

// Vietnamese description of what covers the point (lon, lat); never throws
function describeLookup(lon, lat, data) {
  if (!validLatLon(lat, lon)) {
    return errorResult('invalid-coordinates', 'Toạ độ không hợp lệ: cần vĩ độ trong [-90, 90] và kinh độ trong [-180, 180].');
  }
  if (!data || !hasFeatures(data.lines) || !hasFeatures(data.zones)) {
    return errorResult('missing-data', 'Chưa có dữ liệu tuyến metro và vùng TOD để tra cứu.');
  }
  const stations = stationsOf(data);
  if (stations.length === 0) {
    return errorResult('missing-data', 'Dữ liệu không có ga metro nào để tra cứu.');
  }

  let matches;
  try {
    matches = lookup(lon, lat, data).matches;
  } catch (e) {
    return errorResult('missing-data', 'Dữ liệu vùng TOD không đọc được.');
  }

  let category = 'none';
  let zone = null;
  let nearest = null;
  for (const kind of CATEGORY_ORDER) {
    const ofKind = matches.filter((m) => m.kind === kind);
    if (ofKind.length === 0) continue;
    category = kind;
    // among zones of the winning kind, keep the one whose station is closest
    for (const m of ofKind) {
      const onLine = stations.filter((f) => f.properties.line === m.line &&
        (kind === 'corridor' || f.properties.name === m.station));
      const n = nearestOf(lon, lat, onLine);
      if (n && (!nearest || n.distance_m < nearest.distance_m)) {
        nearest = n;
        zone = m;
      }
    }
    if (!zone) zone = ofKind[0];
    break;
  }
  if (!nearest) nearest = nearestOf(lon, lat, stations);

  const lineName = 'Tuyến ' + (zone ? zone.line : nearest.line);
  const dist = formatMeters(nearest.distance_m);
  let head;
  if (category === 'none') {
    head = 'Không thuộc vùng TOD hay hành lang tuyến metro nào. Ga gần nhất: ga ' + nearest.station +
      ' (' + lineName + '), cách ' + dist + '.';
  } else if (category === 'corridor') {
    head = CATEGORY_LABELS.corridor + ' ' + lineName + '. Ga gần nhất trên tuyến: ga ' + nearest.station +
      ', cách ' + dist + '.';
  } else {
    head = CATEGORY_LABELS[category] + ' – ' + lineName + ', ga ' + nearest.station + ', cách ga ' + dist + '.';
  }

  const props = zone || nearest.feature.properties;
  const parts = [head, describeStatus(props.status), describeSource(props.source)];
  const pilotMatches = matches.filter((m) => m.kind === 'pilot');
  const pilot = [...new Set(pilotMatches.map((m) => m.name).filter(Boolean))];
  if (pilot.length > 0) {
    const pilotLines = [...new Set(pilotMatches.map((m) => 'Tuyến ' + m.line))];
    parts.push('Nằm trong Khu TOD thí điểm / ưu tiên: ' + pilot.join(', ') + ' (' + pilotLines.join(', ') + ').');
  }
  const result = {
    category,
    text: parts.join(' '),
    nearest: {
      line: nearest.line,
      station: nearest.station,
      distance_m: Math.round(nearest.distance_m),
      status: props.status,
      source: props.source || null,
    },
  };
  if (pilot.length > 0) result.pilot = pilot;
  return result;
}

// '#p=lat,lon' with 5 decimals
function formatShareHash(lat, lon) {
  return '#p=' + Number(lat).toFixed(5) + ',' + Number(lon).toFixed(5);
}

const SHARE_RE = /^#?p=([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)$/;

// '#p=lat,lon' (the '#' is optional) -> {lat, lon} or null
function parseShareHash(hash) {
  if (typeof hash !== 'string') return null;
  const m = SHARE_RE.exec(hash.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return validLatLon(lat, lon) ? { lat, lon } : null;
}

if (IS_NODE) {
  module.exports = { VALID_STATUSES, loadData, lookup, parseCoords, describeLookup, formatShareHash, parseShareHash };
} else if (typeof window !== 'undefined') {
  window.HcmTod = { VALID_STATUSES, lookup, parseCoords, describeLookup, formatShareHash, parseShareHash };
}
