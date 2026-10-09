// §18 radar rain rate (pure): RainViewer pixel RGBA → dBZ → mm/h.
// Colour table = RainViewer "Universal Blue" (API colour scheme 2), rain column, dBZ −10..75, from the official table
// https://www.rainviewer.com/api/color-schemes.html (CSV: https://www.rainviewer.com/files/rainviewer_api_colors_table.csv).
// Below −10 dBZ is transparent; 76..95 repeat 75's #00ff00. Decode unsmoothed tiles (options 0_0) so pixels are exact table colours.
const UNIVERSAL_BLUE = (
  '63615914 66635a19 69665c1e 6c685d24 6f6b5f29 726e612e 75706234 78736439 7c75653e 7f786744 ' +
  '827b6949 857d6a4e 88806c54 8b826d59 8e856f5e 92887164 9e93756e aa9e7978 b6a97e82 c2b4828c ' +
  'cec08796 d2c48ba0 d6c88faa dacc93b4 ded097be 88ddeeff 6cd1ebff 51c5e8ff 36bae5ff 1baee2ff ' +
  '00a3e0ff 009ad5ff 0091caff 0088bfff 007fb4ff 0077aaff 0070a3ff 00699cff 006295ff 005b8eff ' +
  '005588ff 005180ff 004e78ff 004a70ff 004768ff ffee00ff ffe000ff ffd200ff ffc500ff ffb700ff ' +
  'ffaa00ff ff9f00ff ff9500ff ff8b00ff ff8100ff ff4400ff f23600ff e62800ff d91b00ff cd0d00ff ' +
  'c10000ff a80000ff 8f0000ff 760000ff 5d0000ff ffaaffff ff9fffff ff95ffff ff8bffff ff81ffff ' +
  'ff77ffff ff6cffff ff62ffff ff58ffff ff4effff ffffffff ffffffff ffffffff ffffffff ffffffff ' +
  'ffffffff ffffffff ffffffff ffffffff ffffffff 00ff00ff ' +
  '').trim().split(' ');
const MIN_DBZ = -10;
const TABLE = UNIVERSAL_BLUE.map((hex, i) => ({ dbz: MIN_DBZ + i, rgba: [0, 2, 4, 6].map((k) => parseInt(hex.slice(k, k + 2), 16)) }));

// Exact table colour (all four RGBA channels, incl. the official partial alphas of −10..14 dBZ) → lowest matching dBZ.
// Anything else (transparent, anti-aliased/blended or unknown pixels) → null (no echo): never guess a nearest colour.
export function rgbaToDbz(rgba) {
  if (!rgba || !(rgba[3] > 0)) return null;
  const hit = TABLE.find(({ rgba: c }) => c.every((v, i) => v === rgba[i]));
  return hit ? hit.dbz : null;
}

// Marshall–Palmer Z = 200 R^1.6 → R = (10^(dBZ/10) / 200)^(1/1.6) mm/h.
export const dbzToMmH = (dbz) => (dbz == null ? 0 : ((10 ** (dbz / 10)) / 200) ** (1 / 1.6));

export const rgbaToMmH = (rgba) => dbzToMmH(rgbaToDbz(rgba));

const FRAME_S = 600; // RainViewer default frame spacing (10 min)
// Hourly accumulation (mm) from rate frames [{ time (epoch s), mmH }]: Σ mmH × interval h, where each frame's interval is
// the spacing to the next frame (last frame: spacing to the previous one; default 10 min). With `t` (epoch ms), only
// frames in [t − 60 min, t] count. Non-numeric mmH counts as 0. No frames → null.
export function radarAccumMm(frames, t = null) {
  const fs = (frames ?? []).filter((f) => Number.isFinite(f?.time) && (t == null || (f.time * 1000 <= t && f.time * 1000 >= t - 3600e3)))
    .sort((a, b) => a.time - b.time);
  if (!fs.length) return null;
  const sum = fs.reduce((acc, f, i) => {
    const dt = i + 1 < fs.length ? fs[i + 1].time - f.time : i > 0 ? f.time - fs[i - 1].time : FRAME_S;
    return acc + (Number.isFinite(f.mmH) ? f.mmH : 0) * Math.min(dt > 0 ? dt : FRAME_S, 3600) / 3600;
  }, 0);
  return Math.round(sum * 100) / 100;
}
