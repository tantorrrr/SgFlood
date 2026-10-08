// §17 map wiring for crowd clusters + heatmap. Logic lives in clusters.js; this only draws.
import { toPoints, crowdClusters, chronicCandidates, heatWeight, HEAT_HALF_LIFE, sourceLabel } from './clusters.js';
import { HeatmapLayer } from './heatmap-layer.js';

const L = window.L;
const HOT_COLOR = '#D85A30';
const RING_M = 60; // matches INFLUENCE_M

export class CrowdOverlay {
  constructor(map, clusterOpts = {}, crowd = {}) {
    this.clusterOpts = clusterOpts;
    this.crowd = crowd;
    this.map = map;
    map.createPane('crowd-clusters').style.zIndex = 420;
    map.getPane('crowd-clusters').style.pointerEvents = 'none';
    this.renderer = L.svg({ pane: 'crowd-clusters' });
    this.clusterGroup = L.layerGroup().addTo(map);
    this.chronicGroup = L.layerGroup().addTo(map);
    this.heat = new HeatmapLayer();
    this.recent = [];
    this.history = [];
    this.news = [];
    this.hot = [];
  }

  setData({ recent, history, news } = {}) {
    if (recent) this.recent = recent;
    if (history) this.history = history;
    if (news) this.news = news;
  }

  setVisible(group, on) {
    const layer = { clusters: this.clusterGroup, chronic: this.chronicGroup, heat: this.heat }[group];
    if (on) layer.addTo(this.map);
    else layer.remove();
  }

  // t = evaluated time; live = viewing the now window (3 h half-life) vs the past (30 days).
  render(t, live) {
    const byId = new Map([...this.history, ...this.recent].map((r) => [r.id, r]));
    const points = toPoints([...byId.values()], this.news, this.crowd);
    const clusters = crowdClusters(points, t, this.clusterOpts);
    this.hot = clusters.filter((c) => c.status === 'hot');

    this.clusterGroup.clearLayers();
    for (const c of clusters) {
      const hot = c.status === 'hot';
      L.circle(c.latlng, {
        radius: RING_M, renderer: this.renderer, interactive: false,
        color: hot ? HOT_COLOR : '#888', weight: hot ? 3 : 1.5, dashArray: hot ? null : '5 5',
        fill: hot, fillColor: HOT_COLOR, fillOpacity: 0.08,
      }).addTo(this.clusterGroup);
      L.tooltip({ permanent: true, direction: 'top', className: `crowd-label ${hot ? 'hot' : 'weak'}`, offset: [0, -8] })
        .setLatLng(c.latlng)
        .setContent(hot ? sourceLabel(c) : `${sourceLabel(c)} (chưa đủ)`)
        .addTo(this.clusterGroup);
    }

    this.chronicGroup.clearLayers();
    for (const c of chronicCandidates(points, Math.max(t, Date.now()))) {
      L.circleMarker(c.latlng, { radius: 7, renderer: this.renderer, interactive: false, color: HOT_COLOR, weight: 2, dashArray: '3 3', fillColor: '#fff', fillOpacity: 0.9 })
        .addTo(this.chronicGroup);
      L.tooltip({ permanent: true, direction: 'right', className: 'crowd-label chronic', offset: [8, 0] })
        .setLatLng(c.latlng)
        .setContent(`Cộng đồng phát hiện · ${c.days.length} ngày`)
        .addTo(this.chronicGroup);
    }

    const half = live ? HEAT_HALF_LIFE.live : HEAT_HALF_LIFE.history;
    this.heat.setPoints(points.map((p) => ({ lat: p.lat, lng: p.lng, w: heatWeight(p, t, half) })));
    return this.hot;
  }
}
