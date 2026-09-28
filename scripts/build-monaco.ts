// Builds the Monaco world assets in public/monaco/ from
//   assets/monaco.tif  – SRTM 1″ elevation (WGS84)
//   assets/monaco.jpg  – circuit schematic (streets, blocks, parks, harbour, circuit)
//   Sentinel-2 cloudless 2016 tiles (EOX, CC BY 4.0) – downloaded and cached
// Run: npm run build:monaco
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { fromFile } from 'geotiff';
import {
  CENTRELINE_PX, TUNNEL_PX_RANGE, localToLonLat, localToPx, lonLatToLocal, pxToLocal,
} from './monaco-source.ts';

const OUT = 'public/monaco';
const CACHE = 'node_modules/.cache/s2cloudless';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// ── Parameters ──────────────────────────────────────────────
const ROAD_HALF = 5.0; // half road width [m]
const SAMPLE_STEP = 2.0; // centreline resampling [m]
const NEAR_CELL = 2.0; // physics terrain grid [m]
const NEAR_MARGIN = 260; // terrain margin around the circuit [m]
const TEX_CELL = 1.0; // ground texture resolution [m]
const BLEND = 40; // road → natural terrain blend distance [m]
const SEA_FLOOR = -4;
const S2_ZOOM = 14;
const BARRIER_OFFSET = ROAD_HALF + 0.9; // barrier box centre from centreline [m]
const BARRIER_HALF_T = 0.4;
const BARRIER_HALF_H = 0.55;

// ── Sources ─────────────────────────────────────────────────
const map = jpeg.decode(fs.readFileSync('assets/monaco.jpg'), { useTArray: true });
const MW = map.width;
const MH = map.height;
const tif = await (await fromFile('assets/monaco.tif')).getImage();
const DW = tif.getWidth();
const DH = tif.getHeight();
const dem = (await tif.readRasters())[0] as Int16Array | Uint16Array;
const [DLON0, DLAT0] = tif.getOrigin();
const [DRX, DRY] = tif.getResolution();

// ── Schematic classification ────────────────────────────────
const C = { None: 0, Sea: 1, Green: 2, Yellow: 3, White: 4, Road: 5, Track: 6 } as const;
type C = (typeof C)[keyof typeof C];
function excluded(x: number, y: number) {
  return x < 0 || y < 0 || x >= MW || y >= MH ||
    (x > 725 && y > 725) || // "Porte d'accès" legend
    (x > 1350 && y > 575) || // Formula Renault logo, "Vers MENTON"
    (x > 430 && x < 580 && y < 35); // crest at the top
}
function classify(x: number, y: number): C {
  x = Math.round(x);
  y = Math.round(y);
  if (excluded(x, y)) return C.None;
  const i = 4 * (y * MW + x);
  const r = map.data[i], g = map.data[i + 1], b = map.data[i + 2];
  if (b > 200 && r > 90 && r < 175 && g > 150 && g < 215) return C.Sea;
  if (g > r + 15 && g > b + 25) return C.Green;
  if (r > 225 && g > 205 && b < 175) return C.Yellow;
  if (r > 235 && g > 235 && b > 235) return C.White;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 12 && r > 180 && r < 228) return C.Road;
  if (r < 120 && g < 120 && b < 120 && Math.abs(r - b) < 18) return C.Track;
  return C.None;
}
const inSchematic = (e: number, n: number) => {
  const [x, y] = localToPx(e, n);
  return !excluded(Math.round(x), Math.round(y));
};

// ── DEM helpers (local metres) ──────────────────────────────
function demRaw(e: number, n: number): number {
  const [lon, lat] = localToLonLat(e, n);
  const c = (lon - DLON0) / DRX - 0.5;
  const r = (lat - DLAT0) / DRY - 0.5;
  const c0 = Math.max(0, Math.min(DW - 2, Math.floor(c)));
  const r0 = Math.max(0, Math.min(DH - 2, Math.floor(r)));
  const fx = Math.min(1, Math.max(0, c - c0));
  const fy = Math.min(1, Math.max(0, r - r0));
  const g = (i: number, j: number) => dem[(r0 + j) * DW + c0 + i];
  return g(0, 0) * (1 - fx) * (1 - fy) + g(1, 0) * fx * (1 - fy) + g(0, 1) * (1 - fx) * fy + g(1, 1) * fx * fy;
}
// Smoothed DEM (SRTM is a surface model: buildings show up as noise). 3×3 box blur twice on the raw grid.
const demSmooth = (() => {
  let a = Float32Array.from(dem, (v) => Math.max(v, 0));
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float32Array(a.length);
    for (let r = 0; r < DH; r++) {
      for (let c = 0; c < DW; c++) {
        let s = 0, k = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const rr = r + j, cc = c + i;
          if (rr < 0 || cc < 0 || rr >= DH || cc >= DW) continue;
          s += a[rr * DW + cc]; k++;
        }
        b[r * DW + c] = s / k;
      }
    }
    a = b;
  }
  return a;
})();
function demSmoothAt(e: number, n: number): number {
  const [lon, lat] = localToLonLat(e, n);
  const c = Math.max(0, Math.min(DW - 1.001, (lon - DLON0) / DRX - 0.5));
  const r = Math.max(0, Math.min(DH - 1.001, (lat - DLAT0) / DRY - 0.5));
  const c0 = Math.floor(c), r0 = Math.floor(r), fx = c - c0, fy = r - r0;
  const g = (i: number, j: number) => demSmooth[(r0 + j) * DW + c0 + i];
  return g(0, 0) * (1 - fx) * (1 - fy) + g(1, 0) * fx * (1 - fy) + g(0, 1) * (1 - fx) * fy + g(1, 1) * fx * fy;
}

// ── Centreline: snap to the drawn circuit, spline, resample ──
function isTrackPx(x: number, y: number) {
  const i = 4 * (y * MW + x);
  const r = map.data[i], g = map.data[i + 1], b = map.data[i + 2];
  return r < 120 && g < 120 && b < 120 && Math.abs(r - b) < 18 && Math.abs(r - g) < 18;
}
const snapped = CENTRELINE_PX.map(([x, y]) => {
  let sx = 0, sy = 0, n = 0;
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy <= 49 && isTrackPx(x + dx, y + dy)) { sx += x + dx; sy += y + dy; n++; }
  }
  return n > 5 ? [sx / n, sy / n] : [x, y];
});
const ctrl = snapped.map(([x, y]) => pxToLocal(x, y));
// Closed Catmull-Rom, densely evaluated, remembering which control segment each point came from.
const dense: { p: [number, number]; seg: number }[] = [];
for (let i = 0; i < ctrl.length; i++) {
  const p0 = ctrl[(i - 1 + ctrl.length) % ctrl.length], p1 = ctrl[i];
  const p2 = ctrl[(i + 1) % ctrl.length], p3 = ctrl[(i + 2) % ctrl.length];
  for (let k = 0; k < 40; k++) {
    const t = k / 40, t2 = t * t, t3 = t2 * t;
    const f = (a: number, b: number, c: number, d: number) =>
      0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    dense.push({ p: [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])], seg: i });
  }
}
const cum = [0];
for (let i = 1; i <= dense.length; i++) {
  const a = dense[i - 1].p, b = dense[i % dense.length].p;
  cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
const LAP = cum[dense.length];
const NS = Math.round(LAP / SAMPLE_STEP);
const step = LAP / NS;
const sx = new Float64Array(NS), sy = new Float64Array(NS), sz = new Float64Array(NS);
const inTunnel = new Uint8Array(NS);
for (let k = 0, j = 0; k < NS; k++) {
  const s = k * step;
  while (cum[j + 1] < s) j++;
  const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
  const a = dense[j].p, b = dense[(j + 1) % dense.length].p;
  sx[k] = a[0] + (b[0] - a[0]) * t;
  sy[k] = a[1] + (b[1] - a[1]) * t;
  const seg = dense[j].seg;
  inTunnel[k] = seg >= TUNNEL_PX_RANGE[0] && seg < TUNNEL_PX_RANGE[1] ? 1 : 0;
}
// Road elevation: smoothed DEM along the line, then a ±60 m moving average, never below the quay.
{
  const raw = Array.from({ length: NS }, (_, k) => demSmoothAt(sx[k], sy[k]));
  const W = Math.round(60 / step);
  for (let k = 0; k < NS; k++) {
    let s = 0;
    for (let j = -W; j <= W; j++) s += raw[(k + j + NS) % NS];
    sz[k] = Math.max(3, s / (2 * W + 1));
  }
}
console.log(`lap ${LAP.toFixed(0)} m, ${NS} samples, z ${Math.min(...sz).toFixed(1)}–${Math.max(...sz).toFixed(1)} m`);

// Spatial hash for nearest-centreline queries.
const HASH = 16;
const hash = new Map<string, number[]>();
for (let k = 0; k < NS; k++) {
  const key = `${Math.floor(sx[k] / HASH)},${Math.floor(sy[k] / HASH)}`;
  (hash.get(key) ?? hash.set(key, []).get(key)!).push(k);
}
/** Distance to the centreline (segment-accurate) and the sample index of the nearest segment start. */
function nearest(x: number, y: number, radius: number, skip?: (k: number) => boolean) {
  let best = Infinity, bi = -1, bt = 0;
  const cx = Math.floor(x / HASH), cy = Math.floor(y / HASH), R = Math.ceil(radius / HASH);
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
    const list = hash.get(`${cx + i},${cy + j}`);
    if (!list) continue;
    for (const k of list) {
      if (skip?.(k)) continue;
      const k2 = (k + 1) % NS;
      const ax = sx[k], ay = sy[k], dx = sx[k2] - ax, dy = sy[k2] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      if (d < best) { best = d; bi = k; bt = t; }
    }
  }
  const z = bi < 0 ? 0 : sz[bi] + (sz[(bi + 1) % NS] - sz[bi]) * bt;
  return { d: best, k: bi, z };
}

// ── Near terrain (physics hfield) ───────────────────────────
let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
for (let k = 0; k < NS; k++) {
  minE = Math.min(minE, sx[k]); maxE = Math.max(maxE, sx[k]);
  minN = Math.min(minN, sy[k]); maxN = Math.max(maxN, sy[k]);
}
const E0 = Math.floor((minE - NEAR_MARGIN) / 10) * 10;
const N0 = Math.floor((minN - NEAR_MARGIN) / 10) * 10;
const NX = Math.ceil((maxE + NEAR_MARGIN - E0) / NEAR_CELL) + 1;
const NY = Math.ceil((maxN + NEAR_MARGIN - N0) / NEAR_CELL) + 1;
const isSea = (e: number, n: number) =>
  inSchematic(e, n) ? classify(...localToPx(e, n)) === C.Sea : demRaw(e, n) <= 0.5;
const near = new Float32Array(NX * NY);
const EDGE = 80; // blend back to the raw DEM near the grid edge so the far mesh meets it
for (let j = 0; j < NY; j++) {
  for (let i = 0; i < NX; i++) {
    const e = E0 + i * NEAR_CELL, n = N0 + j * NEAR_CELL;
    let h = demSmoothAt(e, n);
    const q = nearest(e, n, ROAD_HALF + BLEND + 4);
    if (isSea(e, n) && q.d > ROAD_HALF + 3) h = SEA_FLOOR;
    else h = Math.max(h, 2);
    if (q.k >= 0) {
      const t = Math.min(1, Math.max(0, (q.d - ROAD_HALF - 2) / BLEND));
      const sm = t * t * (3 - 2 * t);
      h = q.z + (h - q.z) * sm;
    }
    const edge = Math.min(i, j, NX - 1 - i, NY - 1 - j) * NEAR_CELL;
    if (edge < EDGE) {
      const w = edge / EDGE;
      h = h * w + demRaw(e, n) * (1 - w);
    }
    near[j * NX + i] = h;
  }
}
console.log(`near terrain ${NX}×${NY} @ ${NEAR_CELL} m, origin (${E0}, ${N0})`);
const nearAt = (e: number, n: number) => {
  const i = Math.max(0, Math.min(NX - 1, Math.round((e - E0) / NEAR_CELL)));
  const j = Math.max(0, Math.min(NY - 1, Math.round((n - N0) / NEAR_CELL)));
  return near[j * NX + i];
};

// ── Sentinel-2 cloudless mosaic (Web Mercator tiles) ────────
const lon2tx = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2ty = (lat: number, z: number) =>
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const DLON1 = DLON0 + DW * DRX, DLAT1 = DLAT0 + DH * DRY;
const TX0 = Math.floor(lon2tx(DLON0, S2_ZOOM)), TX1 = Math.floor(lon2tx(DLON1, S2_ZOOM));
const TY0 = Math.floor(lat2ty(DLAT0, S2_ZOOM)), TY1 = Math.floor(lat2ty(DLAT1, S2_ZOOM));
const TW = (TX1 - TX0 + 1) * 256, TH = (TY1 - TY0 + 1) * 256;
const s2 = new Uint8Array(TW * TH * 4);
for (let ty = TY0; ty <= TY1; ty++) {
  for (let tx = TX0; tx <= TX1; tx++) {
    const file = path.join(CACHE, `${S2_ZOOM}_${tx}_${ty}.jpg`);
    if (!fs.existsSync(file)) {
      const url = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${S2_ZOOM}/${ty}/${tx}.jpg`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    const t = jpeg.decode(fs.readFileSync(file), { useTArray: true });
    for (let y = 0; y < 256; y++) {
      const dst = ((ty - TY0) * 256 + y) * TW + (tx - TX0) * 256;
      s2.set(t.data.subarray(y * 256 * 4, (y + 1) * 256 * 4), dst * 4);
    }
  }
}
fs.writeFileSync(`${OUT}/s2.jpg`, jpeg.encode({ width: TW, height: TH, data: s2 }, 88).data);
const s2At = (e: number, n: number): [number, number, number] => {
  const [lon, lat] = localToLonLat(e, n);
  const x = Math.round((lon2tx(lon, S2_ZOOM) - TX0) * 256), y = Math.round((lat2ty(lat, S2_ZOOM) - TY0) * 256);
  const i = 4 * (Math.max(0, Math.min(TH - 1, y)) * TW + Math.max(0, Math.min(TW - 1, x)));
  return [s2[i], s2[i + 1], s2[i + 2]];
};
console.log(`s2 mosaic ${TW}×${TH} (z${S2_ZOOM} tiles ${TX0}-${TX1}, ${TY0}-${TY1})`);

// ── Ground texture for the near terrain ─────────────────────
const GW = Math.round(((NX - 1) * NEAR_CELL) / TEX_CELL), GH = Math.round(((NY - 1) * NEAR_CELL) / TEX_CELL);
const ground = new Uint8Array(GW * GH * 4);
const COLORS: Record<number, [number, number, number]> = {
  [C.Sea]: [40, 80, 120],
  [C.Green]: [96, 132, 70],
  [C.Yellow]: [205, 190, 150],
  [C.White]: [168, 164, 156],
  [C.Road]: [92, 92, 96],
  [C.Track]: [70, 70, 74],
};
for (let y = 0; y < GH; y++) {
  for (let x = 0; x < GW; x++) {
    // Texture row 0 is the north edge.
    const e = E0 + (x + 0.5) * TEX_CELL, n = N0 + (GH - y - 0.5) * TEX_CELL;
    const photo = s2At(e, n);
    let rgb = photo;
    const [px, py] = localToPx(e, n);
    let c = classify(px, py);
    if (c === C.Track && nearest(e, n, 12).d > ROAD_HALF + 3) c = C.None; // numbered label boxes
    if (c === C.None && !excluded(Math.round(px), Math.round(py))) {
      // Labels and icons: take the most common class around it.
      const votes = new Map<C, number>();
      for (let r = 2; r <= 8 && votes.size === 0; r += 3) {
        for (let a = 0; a < 8; a++) {
          const v = classify(px + r * Math.cos(a), py + r * Math.sin(a));
          if (v !== C.None && v !== C.Track) votes.set(v, (votes.get(v) ?? 0) + 1);
        }
      }
      c = [...votes].sort((p, q) => q[1] - p[1])[0]?.[0] ?? C.None;
    }
    if (c !== C.None && c !== C.Sea) {
      const k = COLORS[c];
      rgb = [k[0] * 0.7 + photo[0] * 0.3, k[1] * 0.7 + photo[1] * 0.3, k[2] * 0.7 + photo[2] * 0.3];
    }
    const i = 4 * (y * GW + x);
    ground[i] = rgb[0]; ground[i + 1] = rgb[1]; ground[i + 2] = rgb[2]; ground[i + 3] = 255;
  }
}
fs.writeFileSync(`${OUT}/ground.jpg`, jpeg.encode({ width: GW, height: GH, data: ground }, 85).data);
console.log(`ground texture ${GW}×${GH}`);

// ── Buildings: schematic blocks → footprints ────────────────
// Work in schematic pixels (≈0.97 m): building = white/yellow, eroded 3 px away from anything else.
const cls = new Uint8Array(MW * MH);
for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) cls[y * MW + x] = classify(x, y);
const isBlock = (c: number) => c === C.White || c === C.Yellow;
const ER = 3;
const bmask = new Uint8Array(MW * MH);
for (let y = ER; y < MH - ER; y++) {
  for (let x = ER; x < MW - ER; x++) {
    if (!isBlock(cls[y * MW + x])) continue;
    let ok = true;
    for (let j = -ER; j <= ER && ok; j++) for (let i = -ER; i <= ER; i++) {
      if (!isBlock(cls[(y + j) * MW + x + i])) { ok = false; break; }
    }
    if (!ok) continue;
    const [e, n] = pxToLocal(x, y);
    if (nearest(e, n, 20).d < ROAD_HALF + 9) continue; // keep the circuit edge open
    bmask[y * MW + x] = 1;
  }
}
// Blocks touching the water are quays and piers, not buildings: mark pixels within 8 px of the sea.
const nearSea = new Uint8Array(MW * MH);
{
  const SR = 8;
  const rowMax = new Uint8Array(MW * MH);
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      if (cls[y * MW + x] !== C.Sea) continue;
      for (let i = Math.max(0, x - SR); i <= Math.min(MW - 1, x + SR); i++) rowMax[y * MW + i] = 1;
    }
  }
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      if (!rowMax[y * MW + x]) continue;
      for (let j = Math.max(0, y - SR); j <= Math.min(MH - 1, y + SR); j++) nearSea[j * MW + x] = 1;
    }
  }
}
// Connected components (4-neighbour), then outer contour by marching squares.
const label = new Int32Array(MW * MH);
type Building = { poly: number[]; z0: number; z1: number; color: number };
const buildings: Building[] = [];
let rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
let nextLabel = 0;
for (let y0 = 0; y0 < MH; y0++) {
  for (let x0 = 0; x0 < MW; x0++) {
    if (!bmask[y0 * MW + x0] || label[y0 * MW + x0]) continue;
    const id = ++nextLabel;
    const stack = [y0 * MW + x0];
    label[y0 * MW + x0] = id;
    let area = 0, yellow = 0, wet = 0, minX = x0, minY = y0;
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      if (cls[p] === C.Yellow) yellow++;
      if (nearSea[p]) wet++;
      const x = p % MW, y = (p / MW) | 0;
      if (y < minY || (y === minY && x < minX)) { minX = x; minY = y; }
      for (const q of [p - 1, p + 1, p - MW, p + MW]) {
        if (bmask[q] && !label[q]) { label[q] = id; stack.push(q); }
      }
    }
    if (area < 120 || wet > 0) continue;
    const contour = traceContour(label, id, minX, minY);
    const simple = simplify(contour, 1.6).map(([x, y]) => pxToLocal(x, y));
    if (simple.length < 3) continue;
    const landmark = yellow > area / 2;
    // Landmarks (casino, hotels) stay whole; ordinary blocks are cut into 18–30 m strips.
    for (const piece of landmark ? [simple] : sliceBlock(simple)) {
      if (piece.length < 3 || Math.abs(ringArea(piece)) < 40) continue;
      let zmin = Infinity, zmax = -Infinity;
      for (const [e, n] of piece) {
        const h = nearAt(e, n);
        zmin = Math.min(zmin, h); zmax = Math.max(zmax, h);
      }
      const height = landmark ? 16 + rand() * 6 : 9 + 34 * rand() ** 1.6;
      buildings.push({
        poly: piece.flatMap(([e, n]) => [+e.toFixed(2), +n.toFixed(2)]),
        z0: +(zmin - 1).toFixed(2), z1: +(zmax + height).toFixed(2),
        color: landmark ? 0 : 1 + Math.floor(rand() * 5),
      });
    }
  }
}
console.log(`${buildings.length} buildings`);

function ringArea(r: [number, number][]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Cut a footprint into strips across its long axis (Sutherland–Hodgman against two parallel lines). */
function sliceBlock(ring: [number, number][]): [number, number][][] {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of ring) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const proj = ring.map(([x, y]) => (x - cx) * ux + (y - cy) * uy);
  const lo = Math.min(...proj), hi = Math.max(...proj);
  const clip = (poly: [number, number][], keep: (t: number) => number) => {
    const out: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = keep((a[0] - cx) * ux + (a[1] - cy) * uy), fb = keep((b[0] - cx) * ux + (b[1] - cy) * uy);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  const pieces: [number, number][][] = [];
  for (let t0 = lo; t0 < hi - 1; ) {
    const t1 = hi - t0 < 36 ? hi + 1 : t0 + 18 + rand() * 12;
    const piece = clip(clip(ring, (t) => t - t0), (t) => t1 - t);
    if (piece.length >= 3) pieces.push(piece);
    t0 = t1;
  }
  return pieces;
}

/** Outer boundary of one labelled region (pixel-corner coordinates), starting at its top-left pixel. */
function traceContour(lab: Int32Array, id: number, sx0: number, sy0: number): [number, number][] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < MW && y < MH && lab[y * MW + x] === id;
  // Walk pixel edges keeping the region on the right-hand side. Directions: 0 E, 1 S, 2 W, 3 N.
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  let x = sx0, y = sy0, dir = 0;
  const pts: [number, number][] = [];
  const startKey = `${x},${y},${dir}`;
  for (let guard = 0; guard < 400000; guard++) {
    pts.push([x, y]);
    x += DX[dir]; y += DY[dir];
    // The two pixels ahead of the new corner: [ahead-left, ahead-right].
    const ahead = [
      [[x, y - 1], [x, y]],
      [[x, y], [x - 1, y]],
      [[x - 1, y], [x - 1, y - 1]],
      [[x - 1, y - 1], [x, y - 1]],
    ][dir];
    const l = inside(ahead[0][0], ahead[0][1]), r = inside(ahead[1][0], ahead[1][1]);
    if (l) dir = (dir + 3) % 4; // turn left
    else if (!r) dir = (dir + 1) % 4; // turn right
    if (`${x},${y},${dir}` === startKey) break;
  }
  return pts;
}

/** Douglas–Peucker on a closed ring. */
function simplify(ring: [number, number][], tol: number): [number, number][] {
  if (ring.length < 4) return ring;
  const out: [number, number][] = [];
  const rec = (a: number, b: number) => {
    let md = 0, mi = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - ring[i][1]) - (ax - ring[i][0]) * (by - ay)) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { rec(a, mi); rec(mi, b); } else out.push(ring[a]);
  };
  const mid = ring.length >> 1;
  rec(0, mid);
  rec(mid, ring.length - 1);
  return out;
}

// ── Trees in parks ──────────────────────────────────────────
const trees: number[] = [];
for (let y = 0; y < MH; y += 7) {
  for (let x = 0; x < MW; x += 7) {
    const jx = x + (rand() - 0.5) * 6, jy = y + (rand() - 0.5) * 6;
    if (classify(jx, jy) !== C.Green) continue;
    const [e, n] = pxToLocal(jx, jy);
    if (nearest(e, n, 12).d < ROAD_HALF + 4) continue;
    trees.push(+e.toFixed(1), +n.toFixed(1), +nearAt(e, n).toFixed(2), +(0.8 + rand() * 0.6).toFixed(2));
  }
}
console.log(`${trees.length / 4} trees`);

// ── Barriers (collision boxes) along both road edges ────────
// Skip a barrier piece where it would sit on another part of the circuit.
const barriers: number[] = [];
for (const side of [1, -1]) {
  let runStart = -1;
  const flush = (a: number, b: number) => {
    // Split [a, b] into pieces ≤ 10 m, shorter in bends.
    let k = a;
    while (k < b) {
      let e = k + 1;
      while (e < b && (e - k) * step < 10) {
        const h0 = Math.atan2(sy[(k + 1) % NS] - sy[k], sx[(k + 1) % NS] - sx[k]);
        const h1 = Math.atan2(sy[(e + 1) % NS] - sy[e % NS], sx[(e + 1) % NS] - sx[e % NS]);
        let dh = Math.abs(h1 - h0); if (dh > Math.PI) dh = 2 * Math.PI - dh;
        if (dh > 0.12) break;
        e++;
      }
      const p = offsetPoint(k, side), q = offsetPoint(e % NS, side);
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len > 0.3) {
        const cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2, cz = (p[2] + q[2]) / 2 + BARRIER_HALF_H;
        const yaw = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const pitch = Math.atan2(q[2] - p[2], len);
        barriers.push(+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2), +(len / 2 + 0.25).toFixed(2),
          +yaw.toFixed(4), +pitch.toFixed(4));
      }
      k = e;
    }
  };
  for (let k = 0; k <= NS; k++) {
    const kk = k % NS;
    const [bx, by] = offsetPoint(kk, side);
    const far = (j: number) => {
      let d = Math.abs(j - kk); d = Math.min(d, NS - d);
      return d * step < 40;
    };
    const ok = k < NS && nearest(bx, by, 16, far).d > BARRIER_OFFSET + BARRIER_HALF_T + 0.3;
    if (ok && runStart < 0) runStart = k;
    if ((!ok || k === NS) && runStart >= 0) { flush(runStart, k); runStart = -1; }
  }
}
function offsetPoint(k: number, side: number): [number, number, number] {
  const a = (k - 1 + NS) % NS, b = (k + 1) % NS;
  const tx = sx[b] - sx[a], ty = sy[b] - sy[a], L = Math.hypot(tx, ty);
  // side 1 = left of the racing direction
  return [sx[k] - (ty / L) * BARRIER_OFFSET * side, sy[k] + (tx / L) * BARRIER_OFFSET * side, sz[k]];
}
console.log(`${barriers.length / 6} barrier pieces`);

// ── Far terrain: whole DEM ──────────────────────────────────
const far = new Float32Array(DW * DH);
for (let i = 0; i < DW * DH; i++) far[i] = dem[i] <= 0 ? SEA_FLOOR - 2 : dem[i];

// ── Write ───────────────────────────────────────────────────
fs.writeFileSync(`${OUT}/near.f32`, Buffer.from(near.buffer));
fs.writeFileSync(`${OUT}/far.f32`, Buffer.from(far.buffer));
const round = (a: Float64Array, d = 2) => Array.from(a, (v) => +v.toFixed(d));
const [farE0, farN1] = lonLatToLocal(DLON0, DLAT0);
const [farE1, farN0] = lonLatToLocal(DLON1, DLAT1);
fs.writeFileSync(`${OUT}/world.json`, JSON.stringify({
  attribution: 'Sentinel-2 cloudless 2016 – s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0. Elevation: SRTM.',
  near: { e0: E0, n0: N0, cell: NEAR_CELL, nx: NX, ny: NY },
  far: { nx: DW, ny: DH, e0: farE0, e1: farE1, n0: farN0, n1: farN1, lon0: DLON0, lat0: DLAT0, dlon: DRX, dlat: DRY },
  s2: { zoom: S2_ZOOM, tx0: TX0, ty0: TY0, width: TW, height: TH },
  track: {
    halfWidth: ROAD_HALF, step, lap: LAP,
    x: round(sx), y: round(sy), z: round(sz), tunnel: Array.from(inTunnel),
  },
  barriers: { halfThickness: BARRIER_HALF_T, halfHeight: BARRIER_HALF_H, pieces: barriers },
  buildings,
  trees,
}));
console.log('wrote', fs.readdirSync(OUT).map((f) => `${f} ${(fs.statSync(`${OUT}/${f}`).size / 1024).toFixed(0)}K`).join(', '));
