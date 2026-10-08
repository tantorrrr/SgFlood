// §17 heatmap: self-drawn canvas Leaflet layer (no plugin). Points accumulate as blurred alpha blobs,
// then the alpha channel is colourised teal → amber → red (alpha also grows with density).
const L = window.L;
const RADIUS_PX = 28;

function makeRamp() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, '#1D9E95');
  grad.addColorStop(0.5, '#EFA22B');
  grad.addColorStop(1, '#D32F2F');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 1);
  return g.getImageData(0, 0, 256, 1).data;
}

export const HeatmapLayer = L.Layer.extend({
  initialize() {
    this._points = []; // [{ lat, lng, w }]
    this._max = 1;
  },

  setPoints(points) {
    this._points = points.filter((p) => p.w > 0);
    this._max = Math.max(1, ...this._points.map((p) => p.w));
    if (this._map) this._redraw();
    return this;
  },

  onAdd(map) {
    this._canvas = L.DomUtil.create('canvas', 'heatmap-layer');
    this._canvas.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(this._canvas);
    this._ramp ??= makeRamp();
    map.on('moveend zoomend resize', this._redraw, this);
    map.on('zoomstart', this._hide, this);
    this._redraw();
  },

  onRemove(map) {
    map.off('moveend zoomend resize', this._redraw, this);
    map.off('zoomstart', this._hide, this);
    this._canvas.remove();
    this._canvas = null;
  },

  // Blobs are drawn for one zoom level; hide them while Leaflet animates to the next instead of showing a stale frame.
  _hide() {
    if (this._canvas) this._canvas.style.visibility = 'hidden';
  },

  _redraw() {
    const map = this._map;
    if (!map || !this._canvas || map._animatingZoom) return; // zoomend redraws once the animation settles
    this._canvas.style.visibility = '';
    const size = map.getSize();
    const c = this._canvas;
    c.width = size.x; c.height = size.y;
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    const g = c.getContext('2d');
    g.clearRect(0, 0, size.x, size.y);
    if (!this._points.length) return;
    const r = RADIUS_PX * Math.max(0.6, Math.min(2, 2 ** ((map.getZoom() - 13) / 2)));
    for (const p of this._points) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      if (pt.x < -r || pt.y < -r || pt.x > size.x + r || pt.y > size.y + r) continue;
      const grad = g.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
      grad.addColorStop(0, `rgba(0,0,0,${Math.min(1, 0.15 + 0.85 * p.w / this._max)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(pt.x - r, pt.y - r, 2 * r, 2 * r);
    }
    const img = g.getImageData(0, 0, size.x, size.y);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (!a) continue;
      const k = a * 4;
      d[i - 3] = this._ramp[k]; d[i - 2] = this._ramp[k + 1]; d[i - 1] = this._ramp[k + 2];
      d[i] = Math.min(220, 40 + a);
    }
    g.putImageData(img, 0, 0);
  },
});
