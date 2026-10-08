import { bilinear } from './risk.js';

const L = window.L;
const SIZE = 120;
const STOPS = [
  [0.2, [129, 199, 132, 0]],
  [0.5, [178, 223, 138, 140]],
  [2, [76, 175, 80, 180]],
  [5, [255, 235, 59, 200]],
  [10, [255, 152, 0, 215]],
  [20, [229, 57, 53, 230]],
  [40, [142, 36, 170, 240]],
];

function rainColor(mm) {
  if (mm < STOPS[0][0]) return null;
  for (let k = 1; k < STOPS.length; k++) {
    const [v1, c1] = STOPS[k];
    if (mm <= v1) {
      const [v0, c0] = STOPS[k - 1];
      const f = (mm - v0) / (v1 - v0);
      return c0.map((x, j) => Math.round(x + (c1[j] - x) * f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export class RainOverlay {
  constructor(map, bbox) {
    const [s, w, n, e] = bbox;
    this.bbox = bbox;
    this.canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
    this.overlay = L.imageOverlay(this.canvas.toDataURL(), [[s, w], [n, e]], { opacity: 0.5, interactive: false });
    this.map = map;
  }

  setVisible(on) {
    if (on) this.overlay.addTo(this.map);
    else this.overlay.remove();
  }

  draw(grid, values) {
    const [s, w, n, e] = this.bbox;
    const ctx = this.canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      const lat = n - ((y + 0.5) / SIZE) * (n - s);
      for (let x = 0; x < SIZE; x++) {
        const c = values ? rainColor(bilinear(grid, values, lat, w + ((x + 0.5) / SIZE) * (e - w))) : null;
        if (c) img.data.set(c, (y * SIZE + x) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    this.overlay.setUrl(this.canvas.toDataURL());
  }
}
