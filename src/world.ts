// MJCF for the Monaco street circuit: terrain heightfield, barriers, and an F1-style car.
// Grew out of "Cell 3: Parameters" / "Cell 4: World XML Builder" of the Kaggle notebook
// "Car Manual Drive in MuJoCo Field".
import type { MonacoData } from './monaco.ts';

export const SIM_DT = 0.004; // physics timestep [s] → 250 Hz (fast car, thin barriers)

// Car geometry
export const WHEEL_RADIUS = 0.33;
export const WHEELBASE = 3.6;
export const TRACK_WIDTH = 1.6;
export const AXLE_H = WHEEL_RADIUS + 0.02; // chassis origin height above the road
export const MAX_STEER_RAD = 0.55; // ≈ 31 deg (Monaco lock)

// Drive
export const MAX_SPEED_KMH = 300;
export const MAX_WHEEL_VEL = MAX_SPEED_KMH / 3.6 / WHEEL_RADIUS; // rad/s ≈ 252
export const ACCEL_RATE = 30; // rad/s per second (≈ 1 g)
export const BRAKE_RATE = 60; // rad/s per second
export const COAST_RATE = 4; // natural deceleration
export const DOWNFORCE = 2.2; // N per (m/s)²

// Suspension per wheel (slide joint): N/m and N·s/m
export const SUSP_STIFFNESS = 90000;
export const SUSP_DAMPING = 5000;

/** Start slot: this many samples behind the start/finish line. */
export const GRID_SAMPLES_BEHIND = 10;

type Attrs = Record<string, string | number>;

class El {
  children: El[] = [];
  tag: string;
  attrs: Attrs;
  constructor(tag: string, attrs: Attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
  }
  sub(tag: string, attrs: Attrs = {}): El {
    const e = new El(tag, attrs);
    this.children.push(e);
    return e;
  }
  toString(indent = ''): string {
    const a = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join('');
    if (!this.children.length) return `${indent}<${this.tag}${a}/>`;
    const inner = this.children.map((c) => c.toString(indent + ' ')).join('\n');
    return `${indent}<${this.tag}${a}>\n${inner}\n${indent}</${this.tag}>`;
  }
}

const v3 = (a: number, b: number, c: number) => `${a} ${b} ${c}`;

export function yawToQuat(yaw: number): [number, number, number, number] {
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
}

/** Terrain height range stored in the hfield (MuJoCo keeps elevation normalised to [0, 1]). */
export function hfieldRange(near: Float32Array) {
  let lo = Infinity, hi = -Infinity;
  for (const h of near) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return { lo, hi };
}

// Livery (dark navy with red and yellow accents)
const NAVY = '0.07 0.09 0.22 1';
const RED = '0.80 0.08 0.14 1';
const YELLOW = '0.98 0.78 0.10 1';
const CARBON = '0.05 0.05 0.06 1';

export function buildWorldXml(data: MonacoData): string {
  const { world, track } = data;
  const { near: nr } = world;
  const root = new El('mujoco', { model: 'monaco' });
  root.sub('compiler', { angle: 'radian' });
  root.sub('option', { gravity: '0 0 -9.81', timestep: SIM_DT });
  root.sub('size', { memory: '64M' });
  const dflt = root.sub('default');
  dflt.sub('geom', { friction: '1.2 0.1 0.001', condim: 4 });

  // ── Terrain heightfield (data filled in after compile, see CarSim) ──
  const { lo, hi } = hfieldRange(data.near);
  const rx = ((nr.nx - 1) * nr.cell) / 2;
  const ry = ((nr.ny - 1) * nr.cell) / 2;
  const asset = root.sub('asset');
  asset.sub('hfield', { name: 'terrain', nrow: nr.ny, ncol: nr.nx, size: `${rx} ${ry} ${hi - lo} 5` });

  const wb = root.sub('worldbody');
  wb.sub('geom', {
    name: 'terrain', type: 'hfield', hfield: 'terrain',
    pos: v3(nr.e0 + rx, nr.n0 + ry, lo), rgba: '0.4 0.4 0.4 1', contype: 1, conaffinity: 1,
  });

  wb.sub('light', {
    directional: 'true', diffuse: '0.85 0.84 0.80', pos: '0 0 300', dir: '-0.35 0.45 -1', castshadow: 'false',
  });
  wb.sub('light', {
    directional: 'true', diffuse: '0.25 0.27 0.33', pos: '0 0 300', dir: '0.5 -0.3 -1', castshadow: 'false',
  });

  // ── Barriers: red / white Armco pieces. Named bar_* for crash detection. ──
  const { pieces, halfThickness, halfHeight } = world.barriers;
  for (let i = 0, n = 0; i < pieces.length; i += 6, n++) {
    const [x, y, z, hl, yaw, pitch] = pieces.slice(i, i + 6);
    // yaw about Z, then pitch about the new Y (nose up = negative rotation about Y)
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2);
    const quat = [cy * cp, -sy * sp, cy * sp, sy * cp].map((q) => q.toFixed(5)).join(' ');
    wb.sub('geom', {
      name: `bar_${n}`, type: 'box', size: v3(hl, halfThickness, halfHeight), pos: v3(x, y, z), quat,
      rgba: n % 2 ? '0.92 0.92 0.92 1' : '0.78 0.10 0.12 1', contype: 1, conaffinity: 1,
    });
  }

  // Outer walls around the terrain patch (named wall_*)
  const wallH = 400;
  const cx = nr.e0 + rx, cyy = nr.n0 + ry;
  for (const [name, px, py, sx, sy] of [
    ['wall_n', cx, cyy + ry, rx, 1], ['wall_s', cx, cyy - ry, rx, 1],
    ['wall_e', cx + rx, cyy, 1, ry], ['wall_w', cx - rx, cyy, 1, ry],
  ] as const) {
    wb.sub('geom', {
      name, type: 'box', size: v3(sx, sy, wallH), pos: v3(px, py, 0), rgba: '0 0 0 0', contype: 1, conaffinity: 1,
    });
  }

  // ── Car ─────────────────────────────────────────────────
  const k0 = track.wrap(-GRID_SAMPLES_BEHIND);
  const yaw0 = track.heading[k0];
  const [qw, qx, qy, qz] = yawToQuat(yaw0);
  const chassis = wb.sub('body', {
    name: 'car1_chassis',
    pos: v3(track.x[k0], track.y[k0], track.z[k0] + AXLE_H + 0.05),
    quat: `${qw} ${qx} ${qy} ${qz}`,
  });
  chassis.sub('freejoint', { name: 'car1_free' });

  const box = (name: string, pos: string, size: string, rgba: string, mass: number, collide = false) =>
    chassis.sub('geom', {
      name, type: 'box', pos, size, rgba, mass,
      contype: collide ? 1 : 0, conaffinity: collide ? 1 : 0,
    });
  const capsule = (name: string, fromto: string, r: number, rgba: string) =>
    chassis.sub('geom', { name, type: 'capsule', fromto, size: r, rgba, mass: 1, contype: 0, conaffinity: 0 });

  box('car1_body', '0.3 0 0.02', '1.9 0.28 0.14', NAVY, 420, true); // monocoque (collides)
  box('car1_floor', '0 0 -0.2', '1.95 0.66 0.015', CARBON, 20);
  box('car1_nose', '2.5 0 -0.03', '0.6 0.13 0.08', NAVY, 10);
  box('car1_nose_tip', '3.12 0 -0.06', '0.08 0.1 0.06', YELLOW, 1);
  box('car1_fwing', '2.95 0 -0.23', '0.26 0.96 0.025', NAVY, 6);
  box('car1_fwing_flap', '2.85 0 -0.17', '0.12 0.9 0.015', RED, 2);
  box('car1_fwing_ep_l', '2.95 0.97 -0.16', '0.27 0.02 0.09', RED, 1);
  box('car1_fwing_ep_r', '2.95 -0.97 -0.16', '0.27 0.02 0.09', RED, 1);
  box('car1_pod_l', '-0.25 0.52 -0.02', '0.8 0.22 0.15', NAVY, 25);
  box('car1_pod_r', '-0.25 -0.52 -0.02', '0.8 0.22 0.15', NAVY, 25);
  box('car1_pod_stripe_l', '-0.2 0.745 0.0', '0.6 0.006 0.09', RED, 1);
  box('car1_pod_stripe_r', '-0.2 -0.745 0.0', '0.6 0.006 0.09', RED, 1);
  box('car1_engine', '-0.95 0 0.2', '0.95 0.22 0.17', NAVY, 60);
  box('car1_bull_l', '-0.75 0.225 0.22', '0.55 0.005 0.11', RED, 1);
  box('car1_bull_r', '-0.75 -0.225 0.22', '0.55 0.005 0.11', RED, 1);
  box('car1_bull_sun_l', '-0.3 0.226 0.26', '0.12 0.005 0.07', YELLOW, 1);
  box('car1_bull_sun_r', '-0.3 -0.226 0.26', '0.12 0.005 0.07', YELLOW, 1);
  box('car1_airbox', '-0.05 0 0.44', '0.16 0.14 0.12', NAVY, 3);
  box('car1_airbox_in', '0.12 0 0.46', '0.02 0.1 0.08', YELLOW, 1);
  box('car1_diffuser', '-2.15 0 -0.16', '0.26 0.46 0.05', CARBON, 5);
  box('car1_rwing', '-2.45 0 0.56', '0.2 0.52 0.03', NAVY, 4);
  box('car1_rwing_flap', '-2.38 0 0.66', '0.1 0.5 0.02', RED, 1);
  box('car1_rwing_ep_l', '-2.45 0.53 0.45', '0.26 0.02 0.2', RED, 1);
  box('car1_rwing_ep_r', '-2.45 -0.53 0.45', '0.26 0.02 0.2', RED, 1);
  box('car1_rwing_pylon', '-2.3 0 0.32', '0.05 0.03 0.22', CARBON, 1);
  chassis.sub('geom', {
    name: 'car1_helmet', type: 'sphere', pos: '0.32 0 0.33', size: 0.14, rgba: YELLOW, mass: 1,
    contype: 0, conaffinity: 0,
  });
  capsule('car1_halo_c', '0.95 0 0.18 0.72 0 0.44', 0.018, CARBON);
  capsule('car1_halo_l', '0.72 0 0.44 0.2 0.27 0.4', 0.018, CARBON);
  capsule('car1_halo_r', '0.72 0 0.44 0.2 -0.27 0.4', 0.018, CARBON);
  capsule('car1_halo_bl', '0.2 0.27 0.4 0.05 0.27 0.16', 0.018, CARBON);
  capsule('car1_halo_br', '0.2 -0.27 0.4 0.05 -0.27 0.16', 0.018, CARBON);

  // Wheels: sprung (slide joint), front steer + roll, rear roll; all four have a velocity
  // actuator (drive and brake). Contact is a sphere — smooth over heightfield facets at speed.
  const wb2 = WHEELBASE / 2;
  const tw2 = TRACK_WIDTH / 2;
  const wz = -(AXLE_H - WHEEL_RADIUS);
  for (const [wname, x, y, steer, halfW] of [
    ['fl', wb2, tw2, true, 0.15], ['fr', wb2, -tw2, true, 0.15],
    ['rl', -wb2, tw2 + 0.03, false, 0.19], ['rr', -wb2, -tw2 - 0.03, false, 0.19],
  ] as const) {
    const full = `car1_wheel_${wname}`;
    const wbody = chassis.sub('body', { name: full, pos: v3(x, y, wz) });
    wbody.sub('joint', {
      name: `${full}_susp`, type: 'slide', axis: '0 0 1', range: '-0.07 0.07', limited: 'true',
      stiffness: SUSP_STIFFNESS, damping: SUSP_DAMPING, springref: 0.03,
    });
    if (steer) {
      wbody.sub('joint', {
        name: `${full}_steer`, type: 'hinge', axis: '0 0 1', range: `${-MAX_STEER_RAD} ${MAX_STEER_RAD}`, damping: 40,
      });
    }
    wbody.sub('joint', { name: `${full}_roll`, type: 'hinge', axis: '0 1 0', damping: 0.2 });
    wbody.sub('geom', {
      name: `${full}_contact`, type: 'sphere', size: WHEEL_RADIUS, rgba: '0 0 0 0', mass: 12,
      contype: 1, conaffinity: 1, friction: '1.7 0.02 0.0005',
    });
    wbody.sub('geom', {
      name: `${full}_tire`, type: 'cylinder', size: `${WHEEL_RADIUS} ${halfW}`, euler: '1.5708 0 0',
      rgba: '0.1 0.1 0.11 1', mass: 0.1, contype: 0, conaffinity: 0,
    });
    wbody.sub('geom', {
      name: `${full}_band`, type: 'cylinder', size: `${WHEEL_RADIUS + 0.003} ${halfW - 0.05}`,
      euler: '1.5708 0 0', rgba: '0.2 0.55 0.9 1', mass: 0.1, contype: 0, conaffinity: 0,
    });
    wbody.sub('geom', {
      name: `${full}_rim`, type: 'cylinder', size: `0.2 ${halfW + 0.008}`, euler: '1.5708 0 0',
      rgba: '0.55 0.06 0.1 1', mass: 0.1, contype: 0, conaffinity: 0,
    });
  }

  // Cameras: chase (slightly behind and above) and cockpit (driver's eye).
  chassis.sub('camera', { name: 'chase_cam', pos: '-7.5 0 2.3', xyaxes: '0 -1 0 0.16 0 0.99', fovy: 60 });
  chassis.sub('camera', { name: 'cockpit_cam', pos: '0.38 0 0.6', xyaxes: '0 -1 0 0.12 0 0.99', fovy: 75 });

  const actuator = root.sub('actuator');
  for (const w of ['fl', 'fr']) {
    actuator.sub('position', {
      name: `car1_steer_${w}`, joint: `car1_wheel_${w}_steer`, kp: 1500,
      ctrlrange: `${-MAX_STEER_RAD} ${MAX_STEER_RAD}`,
    });
  }
  for (const w of ['fl', 'fr', 'rl', 'rr']) {
    actuator.sub('velocity', {
      name: `car1_drive_${w}`, joint: `car1_wheel_${w}_roll`, kv: 160,
      ctrlrange: `${-MAX_WHEEL_VEL} ${MAX_WHEEL_VEL}`,
    });
  }

  return root.toString();
}
