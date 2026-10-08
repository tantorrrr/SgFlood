// Lazy loader for public/data/dtm.bin (Int16 cm, Hòn Dấu, rows north → south) built by scripts/build-roads.mjs.
let pending = null;

export function loadDtm() {
  pending ??= Promise.all([
    fetch('data/dtm.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`dtm.json HTTP ${r.status}`)))),
    fetch('data/dtm.bin').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`dtm.bin HTTP ${r.status}`)))),
  ]).then(([meta, buf]) => ({ meta, data: new Int16Array(buf) }));
  pending.catch(() => { pending = null; });
  return pending;
}

// Nearest pixel, metres (2 decimals); null outside the grid or on nodata.
export function dtmValueAt({ meta, data }, lat, lng) {
  const i = Math.round((lng - meta.west) / meta.step);
  const j = Math.round((meta.north - lat) / meta.step);
  if (i < 0 || j < 0 || i >= meta.width || j >= meta.height) return null;
  const v = data[j * meta.width + i];
  return v === meta.nodata ? null : Math.round(v * meta.scale * 100) / 100;
}
