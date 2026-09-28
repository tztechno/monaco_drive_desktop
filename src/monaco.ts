// Monaco world data produced by scripts/build-monaco.ts (public/monaco/).

export interface WorldJson {
  attribution: string;
  near: { e0: number; n0: number; cell: number; nx: number; ny: number };
  far: {
    nx: number; ny: number; e0: number; e1: number; n0: number; n1: number;
    lon0: number; lat0: number; dlon: number; dlat: number;
  };
  s2: { zoom: number; tx0: number; ty0: number; width: number; height: number };
  track: {
    halfWidth: number; step: number; lap: number;
    x: number[]; y: number[]; z: number[]; tunnel: number[];
  };
  barriers: { halfThickness: number; halfHeight: number; pieces: number[] };
  buildings: { poly: number[]; z0: number; z1: number; color: number }[];
  trees: number[];
}

export interface MonacoData {
  world: WorldJson;
  near: Float32Array; // row-major, row 0 = south edge (MuJoCo hfield order)
  far: Float32Array; // DEM order: row 0 = north edge
  track: Track;
}

/** Loads the generated world. `read` fetches a file under public/monaco/. */
export async function loadMonaco(read: (file: string) => Promise<ArrayBuffer>): Promise<MonacoData> {
  const [json, near, far] = await Promise.all([read('world.json'), read('near.f32'), read('far.f32')]);
  const world = JSON.parse(new TextDecoder().decode(json)) as WorldJson;
  return { world, near: new Float32Array(near), far: new Float32Array(far), track: new Track(world.track) };
}

/** Closed centreline sampled every `step` metres, in the racing direction. */
export class Track {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly heading: Float64Array;
  readonly curvature: Float64Array; // signed, 1/m (left turn > 0)
  readonly tunnel: Uint8Array;
  readonly step: number;
  readonly length: number;
  readonly halfWidth: number;

  constructor(t: WorldJson['track']) {
    this.n = t.x.length;
    this.x = Float64Array.from(t.x);
    this.y = Float64Array.from(t.y);
    this.z = Float64Array.from(t.z);
    this.tunnel = Uint8Array.from(t.tunnel);
    this.step = t.step;
    this.length = t.lap;
    this.halfWidth = t.halfWidth;
    this.heading = new Float64Array(this.n);
    this.curvature = new Float64Array(this.n);
    for (let k = 0; k < this.n; k++) {
      const a = this.wrap(k - 1), b = this.wrap(k + 1);
      this.heading[k] = Math.atan2(this.y[b] - this.y[a], this.x[b] - this.x[a]);
    }
    const W = 4; // curvature over ±8 m
    for (let k = 0; k < this.n; k++) {
      const d = angleDiff(this.heading[this.wrap(k + W)], this.heading[this.wrap(k - W)]);
      this.curvature[k] = d / (2 * W * this.step);
    }
  }

  wrap(k: number) {
    return ((k % this.n) + this.n) % this.n;
  }

  /**
   * Nearest centreline sample to (x, y). Searches ±`window` samples around `hint`
   * (or everything when hint < 0). Returns index, lateral offset (left > 0) and distance.
   */
  project(x: number, y: number, hint = -1, window = 60) {
    let best = Infinity, bk = 0;
    const from = hint < 0 ? 0 : hint - window;
    const to = hint < 0 ? this.n - 1 : hint + window;
    for (let i = from; i <= to; i++) {
      const k = this.wrap(i);
      const d = (x - this.x[k]) ** 2 + (y - this.y[k]) ** 2;
      if (d < best) { best = d; bk = k; }
    }
    const h = this.heading[bk];
    const lateral = -(x - this.x[bk]) * Math.sin(h) + (y - this.y[bk]) * Math.cos(h);
    return { k: bk, lateral, dist: Math.sqrt(best) };
  }
}

export function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
