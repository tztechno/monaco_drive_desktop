// Hand-traced Circuit de Monaco centreline on assets/monaco.jpg and the
// schematic → geo transform fitted against assets/monaco.tif (see scripts/build-monaco.ts).

/** Local tangent-plane origin: metres east / north of this point. */
export const LON0 = 7.4245;
export const LAT0 = 43.7375;
export const M_PER_DEG_LON = Math.cos((LAT0 * Math.PI) / 180) * 111320;
export const M_PER_DEG_LAT = 110574;

/**
 * Schematic pixel (x right, y down) → local metres: [E, N] = s·R(th)·[x, −y] + t.
 * Found by matching the schematic's sea against DEM cells at or below 0 m.
 */
export const GEOREF = { s: 0.9721, th: (49.58 * Math.PI) / 180, tx: -711.3, ty: -420.4 };

export function pxToLocal(x: number, y: number): [number, number] {
  const { s, th, tx, ty } = GEOREF;
  const u = x * s;
  const v = -y * s;
  return [Math.cos(th) * u - Math.sin(th) * v + tx, Math.sin(th) * u + Math.cos(th) * v + ty];
}

export function localToPx(e: number, n: number): [number, number] {
  const { s, th, tx, ty } = GEOREF;
  const a = e - tx;
  const b = n - ty;
  const u = (Math.cos(th) * a + Math.sin(th) * b) / s;
  const v = (-Math.sin(th) * a + Math.cos(th) * b) / s;
  return [u, -v];
}

export const localToLonLat = (e: number, n: number): [number, number] => [
  LON0 + e / M_PER_DEG_LON,
  LAT0 + n / M_PER_DEG_LAT,
];
export const lonLatToLocal = (lon: number, lat: number): [number, number] => [
  (lon - LON0) * M_PER_DEG_LON,
  (lat - LAT0) * M_PER_DEG_LAT,
];

/** Racing direction, starting at the start/finish line. Schematic pixels. */
export const CENTRELINE_PX: [number, number][] = [
  // Start / finish straight (Boulevard Albert 1er) → Sainte Dévote
  [455, 325], [485, 295], [530, 255], [570, 222], [600, 205], [620, 207], [630, 225],
  // Beau Rivage climb → Massenet
  [650, 245], [680, 265], [730, 300], [780, 335], [830, 370], [860, 385], [930, 415],
  [992, 452], [1030, 470], [1080, 470], [1105, 445],
  // Casino square
  [1110, 400], [1115, 360], [1130, 347], [1180, 335], [1230, 325], [1280, 315], [1330, 310],
  // Mirabeau → hairpin → Portier
  [1352, 330], [1350, 345], [1335, 365], [1326, 392], [1328, 410], [1338, 419], [1348, 404],
  [1351, 375], [1362, 364], [1375, 365], [1395, 380], [1415, 405], [1420, 420], [1412, 432],
  // Tunnel sweep along the coast
  [1390, 460], [1330, 495], [1285, 522], [1225, 547], [1165, 560], [1105, 558], [1045, 545],
  [1030, 530],
  // Nouvelle chicane → Tabac
  [955, 490], [880, 450], [855, 437], [840, 450], [820, 445], [812, 425], [795, 405],
  [730, 355], [680, 315], [630, 280], [600, 265], [550, 270], [510, 290],
  // Swimming pool → Rascasse
  [485, 320], [478, 355], [485, 390], [470, 430], [450, 455], [415, 475], [395, 485],
  [370, 510], [355, 550], [345, 590], [342, 625], [346, 650], [336, 666], [318, 664],
  [304, 645],
  // Anthony Noghes → back up the straight
  [305, 610], [325, 550], [350, 480], [370, 440], [400, 390], [430, 345],
];

/** Index ranges of CENTRELINE_PX covered by the tunnel (inclusive). */
export const TUNNEL_PX_RANGE: [number, number] = [39, 45];
