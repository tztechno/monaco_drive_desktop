// Headless checks in Node: the Monaco world loads, the car sits on the road,
// manual controls respond, and the demo driver completes laps cleanly.
import fs from 'node:fs/promises';
import loadMujoco from '@mujoco/mujoco';
import { loadMonaco } from '../src/monaco.ts';
import { CarSim } from '../src/sim.ts';
import { SIM_DT } from '../src/world.ts';

const mj = await loadMujoco();
const monaco = await loadMonaco(async (f) => {
  const b = await fs.readFile(new URL(`../public/monaco/${f}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
});
const sim = new CarSim(mj, monaco);
const s = sim.state;
let failed = false;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
console.log('ngeom', sim.model.ngeom, 'nu', sim.model.nu, 'lap', monaco.track.length.toFixed(0), 'm');

// Settle on the grid
for (let i = 0; i < 250; i++) sim.step();
const z0 = sim.pose().pos[2] - monaco.track.z[sim.lapState.progress];
check(Math.abs(z0 - 0.35) < 0.15, `rests on the road (chassis ${z0.toFixed(2)} m above centreline)`);
check(sim.hits.size === 0, 'no contacts on the grid');

// Manual: accelerate 3 s, hold 2 s, brake
s.direction = 'forward'; s.pedal = 'accel';
for (let i = 0; i < 3 / SIM_DT; i++) sim.step();
const v1 = sim.pose().speed;
s.pedal = 'hold';
const held = s.wheelVel;
for (let i = 0; i < 1 / SIM_DT; i++) sim.step();
check(s.wheelVel === held, `hold keeps wheel speed (${(v1 * 3.6).toFixed(0)} km/h)`);
s.pedal = 'brake';
for (let i = 0; i < 4 / SIM_DT; i++) sim.step();
check(Math.abs(sim.pose().speed) < 1, 'brake stops the car');
check(sim.lapState.lap === 1, 'crossing the line starts lap 1');

// Demo: two laps
sim.reset();
s.mode = 'demo';
const t0 = performance.now();
const hitLog: string[] = [];
let vmax = 0;
for (let i = 0; i < 400 / SIM_DT && sim.lapState.lap < 3; i++) {
  sim.step();
  vmax = Math.max(vmax, sim.pose().speed);
  if (sim.hits.size) {
    const k = sim.lapState.progress;
    hitLog.push(`${[...sim.hits].join('+')}@${k}(${(k * monaco.track.step).toFixed(0)}m)`);
    sim.hits.clear();
  }
  if (sim.isRolledOver()) break;
}
const wall = (performance.now() - t0) / 1000;
const ls = sim.lapState;
console.log(`demo: laps started ${ls.lap}, last ${ls.last?.toFixed(2)} s, best ${ls.best?.toFixed(2)} s,` +
  ` vmax ${(vmax * 3.6).toFixed(0)} km/h, sim ${sim.data.time.toFixed(1)} s in ${wall.toFixed(1)} s wall` +
  ` (${(sim.data.time / wall).toFixed(1)}× real time)`);
check(!sim.isRolledOver(), 'demo does not roll over');
check(ls.lap >= 3, 'demo completes two full laps');
check(hitLog.length === 0, `demo never touches a barrier ${hitLog.slice(0, 12).join(' ')}`);

// Rollover detection
sim.reset();
sim.data.qpos.set([0, 1, 0, 0], 3); // upside down
let rolled = false;
for (let i = 0; i < 0.5 / SIM_DT && !rolled; i++) {
  sim.step();
  rolled = sim.hits.has('rollover');
}
check(rolled, 'rollover detected');
sim.reset();
check(!sim.isRolledOver(), 'reset clears rollover');

process.exit(failed ? 1 : 0);
