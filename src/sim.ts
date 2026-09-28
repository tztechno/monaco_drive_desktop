// Grew out of "Cell 5: Initialize Simulation" and "Cell 7: Physics Worker".
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import { angleDiff, type MonacoData, type Track } from './monaco.ts';
import {
  ACCEL_RATE, AXLE_H, BRAKE_RATE, COAST_RATE, DOWNFORCE, GRID_SAMPLES_BEHIND, MAX_STEER_RAD,
  MAX_WHEEL_VEL, SIM_DT, WHEEL_RADIUS, WHEELBASE, buildWorldXml, hfieldRange, yawToQuat,
} from './world.ts';

export type Direction = 'forward' | 'reverse' | 'stop';
export type Hit = 'barrier' | 'boundary' | 'rollover';
/** accel: speed up · hold: keep current speed · brake: slow down · none: coast */
export type Pedal = 'accel' | 'hold' | 'brake' | 'none';
export type DriveMode = 'manual' | 'demo';

// Rolled over: chassis up-axis z below this (≈ 73° tilt) for ROLLOVER_STEPS in a row.
const ROLLOVER_UP_Z = 0.3;
const ROLLOVER_STEPS = Math.round(0.2 / SIM_DT);

export interface SimState {
  mode: DriveMode;
  steer: number; // manual steering input, rad (left > 0) before the speed limiter
  direction: Direction;
  pedal: Pedal;
  wheelVel: number; // current wheel speed target [rad/s]
  steerCmd: number; // steering actually sent to the wheels [rad]
}

export interface LapState {
  lap: number; // laps started (0 = still on the grid)
  lapStart: number; // sim time the current lap started [s]
  last: number | null;
  best: number | null;
  progress: number; // nearest centreline sample
}

/** Steering authority shrinks with speed so the car stays drivable at 300 km/h. */
export function steerLimit(speed: number) {
  return Math.max(0.08, 1 / (1 + (speed / 24) ** 2));
}

export class CarSim {
  readonly model: MjModel;
  readonly data: MjData;
  readonly track: Track;
  readonly state: SimState = {
    mode: 'manual', steer: 0, direction: 'stop', pedal: 'none', wheelVel: 0, steerCmd: 0,
  };
  readonly lapState: LapState = { lap: 0, lapStart: 0, last: null, best: null, progress: 0 };
  /** Hits seen since the caller last cleared it. */
  readonly hits = new Set<Hit>();
  readonly autopilot: Autopilot;
  private actSteer: number[];
  private actDrive: number[];
  private freeQposAdr: number;
  private chassisId: number;
  private mj: MainModule;
  private obstacleKind = new Map<number, Hit>();
  private tippedSteps = 0;
  private terrainGeom: number;

  constructor(mj: MainModule, monaco: MonacoData) {
    this.mj = mj;
    this.track = monaco.track;
    this.model = mj.MjModel.from_xml_string(buildWorldXml(monaco));
    this.data = new mj.MjData(this.model);
    // Heightfield elevation, normalised to [0, 1] of the declared range.
    const { lo, hi } = hfieldRange(monaco.near);
    const hd = this.model.hfield_data as Float32Array;
    for (let i = 0; i < hd.length; i++) hd[i] = (monaco.near[i] - lo) / (hi - lo);

    const ACT = mj.mjtObj.mjOBJ_ACTUATOR.value;
    const id = (name: string) => mj.mj_name2id(this.model, ACT, name);
    this.actSteer = ['fl', 'fr'].map((w) => id(`car1_steer_${w}`));
    this.actDrive = ['fl', 'fr', 'rl', 'rr'].map((w) => id(`car1_drive_${w}`));
    const jid = mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_JOINT.value, 'car1_free');
    this.freeQposAdr = this.model.jnt_qposadr[jid];
    this.chassisId = mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_BODY.value, 'car1_chassis');
    const GEOM = mj.mjtObj.mjOBJ_GEOM.value;
    this.terrainGeom = mj.mj_name2id(this.model, GEOM, 'terrain');
    for (let g = 0; g < this.model.ngeom; g++) {
      const name = mj.mj_id2name(this.model, GEOM, g);
      if (name.startsWith('bar_')) this.obstacleKind.set(g, 'barrier');
      else if (name.startsWith('wall_')) this.obstacleKind.set(g, 'boundary');
    }
    this.autopilot = new Autopilot(this.track);
    this.reset();
  }

  /** Put the car on the grid, just behind the start/finish line. */
  reset() {
    const t = this.track;
    const k = t.wrap(-GRID_SAMPLES_BEHIND);
    const qa = this.freeQposAdr;
    this.mj.mj_resetData(this.model, this.data);
    this.data.qpos.set([t.x[k], t.y[k], t.z[k] + AXLE_H + 0.05], qa);
    this.data.qpos.set(yawToQuat(t.heading[k]), qa + 3);
    this.mj.mj_forward(this.model, this.data);
    this.hits.clear();
    this.tippedSteps = 0;
    Object.assign(this.state, { steer: 0, direction: 'stop', pedal: 'none', wheelVel: 0, steerCmd: 0 });
    Object.assign(this.lapState, { lap: 0, lapStart: 0, last: null, best: null, progress: k });
  }

  /** Car (x, y, z) position, yaw and forward speed [m/s]. */
  pose(): { pos: [number, number, number]; yaw: number; speed: number } {
    const q = this.data.qpos;
    const a = this.freeQposAdr;
    const yaw = Math.atan2(2 * (q[a + 3] * q[a + 6] + q[a + 4] * q[a + 5]), 1 - 2 * (q[a + 5] ** 2 + q[a + 6] ** 2));
    const v = this.data.qvel; // free joint: linear velocity in world frame first
    const speed = v[0] * Math.cos(yaw) + v[1] * Math.sin(yaw);
    return { pos: [q[a], q[a + 1], q[a + 2]], yaw, speed };
  }

  /** z component of the chassis up-axis: 1 upright, 0 on its side, -1 upside down. */
  upZ(): number {
    const q = this.data.qpos;
    const a = this.freeQposAdr;
    return 1 - 2 * (q[a + 4] ** 2 + q[a + 5] ** 2);
  }

  isRolledOver(): boolean {
    return this.tippedSteps >= ROLLOVER_STEPS;
  }

  zeroCtrl() {
    this.data.ctrl.fill(0);
    this.state.wheelVel = 0;
  }

  /** One physics tick. */
  step() {
    const st = this.state;
    const { speed } = this.pose();
    let wv = st.wheelVel;

    if (st.mode === 'demo') {
      const cmd = this.autopilot.control(this, speed);
      const target = cmd.speed / WHEEL_RADIUS;
      wv += Math.max(-BRAKE_RATE * SIM_DT, Math.min(ACCEL_RATE * SIM_DT, target - wv));
      st.steerCmd = cmd.steer;
    } else {
      if (st.pedal === 'hold') {
        // Cruise: keep the current wheel speed
      } else if (st.pedal === 'brake' || (st.pedal === 'none' && st.direction === 'stop')) {
        wv -= Math.sign(wv) * BRAKE_RATE * SIM_DT;
        if (Math.abs(wv) < 0.5) wv = 0;
      } else if (st.pedal === 'accel') {
        if (st.direction === 'forward') wv = Math.min(wv + ACCEL_RATE * SIM_DT, MAX_WHEEL_VEL);
        else if (st.direction === 'reverse') wv = Math.max(wv - ACCEL_RATE * SIM_DT, -MAX_WHEEL_VEL * 0.1);
      } else if (wv !== 0) {
        wv -= Math.sign(wv) * COAST_RATE * SIM_DT;
        if (Math.abs(wv) < 0.2) wv = 0;
      }
      st.steerCmd = st.steer * steerLimit(Math.abs(speed));
    }
    st.steerCmd = Math.max(-MAX_STEER_RAD, Math.min(MAX_STEER_RAD, st.steerCmd));

    const ctrl = this.data.ctrl;
    for (const a of this.actSteer) ctrl[a] = st.steerCmd;
    for (const a of this.actDrive) ctrl[a] = wv;
    // Aerodynamic downforce on the chassis
    const xf = this.data.xfrc_applied;
    xf[6 * this.chassisId + 2] = -DOWNFORCE * speed * speed;

    this.mj.mj_step(this.model, this.data);
    st.wheelVel = wv;
    this.detectHits();
    this.tippedSteps = this.upZ() < ROLLOVER_UP_Z ? this.tippedSteps + 1 : 0;
    if (this.isRolledOver()) this.hits.add('rollover');
    this.updateLap();
  }

  private updateLap() {
    const ls = this.lapState;
    const { pos } = this.pose();
    const prev = ls.progress;
    const k = this.track.project(pos[0], pos[1], prev, 40).k;
    ls.progress = k;
    const n = this.track.n;
    // Crossing sample 0 forwards = crossing the start/finish line.
    if (prev > n * 0.8 && k < n * 0.2) {
      const t = this.data.time;
      if (ls.lap > 0) {
        ls.last = t - ls.lapStart;
        ls.best = ls.best === null ? ls.last : Math.min(ls.best, ls.last);
      }
      ls.lap++;
      ls.lapStart = t;
    }
  }

  /** Record car ↔ barrier / wall contacts from the last step (terrain contacts are ignored). */
  private detectHits() {
    const ncon = this.data.ncon;
    if (ncon <= 4) return; // four tyres on the road
    const rootOf = this.model.body_rootid;
    const bodyOf = this.model.geom_bodyid;
    const contacts = this.data.contact;
    try {
      for (let i = 0; i < ncon; i++) {
        const c = contacts.get(i);
        if (!c) continue;
        const { geom1, geom2 } = c;
        c.delete();
        if (geom1 === this.terrainGeom || geom2 === this.terrainGeom) continue;
        const kind = this.obstacleKind.get(geom1) ?? this.obstacleKind.get(geom2);
        const other = this.obstacleKind.has(geom1) ? geom2 : geom1;
        if (kind && rootOf[bodyOf[other]] === this.chassisId) this.hits.add(kind);
      }
    } finally {
      contacts.delete();
    }
  }
}

/**
 * Demo driver: pure-pursuit steering on the centreline and a speed profile from
 * curvature (lateral-grip limit), with braking / acceleration passes.
 */
export class Autopilot {
  readonly targetSpeed: Float64Array; // m/s per centreline sample
  private track: Track;
  static readonly LAT_ACCEL = 10; // m/s²
  static readonly BRAKE_DECEL = 7; // m/s²
  static readonly DRIVE_ACCEL = 8; // m/s²
  static readonly V_MAX = 80; // m/s

  constructor(track: Track) {
    this.track = track;
    const n = track.n;
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      // Use the tightest curvature within ±10 m so the car is already slow at the apex.
      let c = 0;
      for (let j = -5; j <= 5; j++) c = Math.max(c, Math.abs(track.curvature[track.wrap(k + j)]));
      v[k] = Math.min(Autopilot.V_MAX, Math.sqrt(Autopilot.LAT_ACCEL / Math.max(c, 1e-4)));
    }
    const ds = track.step;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 2 * n; i >= 0; i--) { // backwards: brake in time for the next corner
        const k = i % n, k1 = (i + 1) % n;
        v[k] = Math.min(v[k], Math.sqrt(v[k1] ** 2 + 2 * Autopilot.BRAKE_DECEL * ds));
      }
      for (let i = 0; i <= 2 * n; i++) { // forwards: limited acceleration
        const k = i % n, k0 = (i - 1 + n) % n;
        v[k] = Math.min(v[k], Math.sqrt(v[k0] ** 2 + 2 * Autopilot.DRIVE_ACCEL * ds));
      }
    }
    this.targetSpeed = v;
  }

  control(sim: CarSim, speed: number): { steer: number; speed: number } {
    const t = this.track;
    const { pos, yaw } = sim.pose();
    const k = sim.lapState.progress;
    const look = 5 + 0.3 * Math.abs(speed);
    const kt = t.wrap(k + Math.round(look / t.step));
    // Aim point from the rear axle
    const rx = pos[0] - Math.cos(yaw) * (WHEELBASE / 2);
    const ry = pos[1] - Math.sin(yaw) * (WHEELBASE / 2);
    const alpha = angleDiff(Math.atan2(t.y[kt] - ry, t.x[kt] - rx), yaw);
    const ld = Math.hypot(t.x[kt] - rx, t.y[kt] - ry);
    const steer = Math.atan2(2 * WHEELBASE * Math.sin(alpha), ld);
    // Slow down when far off line or badly misaligned (recovering after contact).
    const recover = Math.abs(alpha) > 0.6 ? 0.4 : 1;
    return { steer, speed: this.targetSpeed[t.wrap(k + 2)] * recover };
  }
}
