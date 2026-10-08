// Minor-road tile grid: TILE_DEG cells anchored at the roads bbox south-west corner, id "<row>-<col>".
export const TILE_DEG = 0.02;

// Rounding guards against 10.66 + 0.02·k landing a hair below a cell edge.
const cellOf = (v, origin) => Math.floor(Math.round(((v - origin) / TILE_DEG) * 1e6) / 1e6);

export function tileId([s, w], lat, lng) {
  return `${cellOf(lat, s)}-${cellOf(lng, w)}`;
}

export function tileBbox([s, w], id) {
  const [r, c] = id.split('-').map(Number);
  return [s + r * TILE_DEG, w + c * TILE_DEG, s + (r + 1) * TILE_DEG, w + (c + 1) * TILE_DEG].map((x) => Math.round(x * 1e6) / 1e6);
}

// All tiles of the bbox [s, w, n, e], row-major.
export function gridTiles(bbox) {
  const [s, w, n, e] = bbox;
  const ids = [];
  const [rows, cols] = [-cellOf(s, n), -cellOf(w, e)]; // ceil((n − s) / TILE_DEG), same rounding guard
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) ids.push(`${r}-${c}`);
  return ids;
}

// Tiles touching the view [s, w, n, e] plus `margin` tiles around it (ids may fall outside the grid).
export function tilesForView(bbox, [s, w, n, e], margin = 1) {
  const [r0, c0] = [cellOf(s, bbox[0]) - margin, cellOf(w, bbox[1]) - margin];
  const [r1, c1] = [cellOf(n, bbox[0]) + margin, cellOf(e, bbox[1]) + margin];
  const ids = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) ids.push(`${r}-${c}`);
  return ids;
}
