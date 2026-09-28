// App shell: loading, main loop, cameras, HUD, controls.
// Grew out of "Cell 8: Display Worker" and "Cell 9: UI Panel" of the Kaggle notebook.
import * as THREE from 'three';
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { CarSim, type Direction, type DriveMode, type Hit, type Pedal } from './sim.ts';
import { SceneView, setFreeCamera } from './render.ts';
import { loadMonaco, type Track } from './monaco.ts';
import { MAX_STEER_RAD, SIM_DT } from './world.ts';
import { getLang, onLangChange, setLang, t, type Key } from './i18n.ts';

const MAX_STEPS_PER_FRAME = 30;
const OVERHEAD_DISTANCE = 150; // camera height above the car [m]
const ALERT_HOLD_MS = 1500; // warning stays up this long after the last contact
const BEEP_COUNT = 3; // beeps per warning
const BEEP_SPACING_S = 0.45;
const TRACKSIDE_SPACING = 130; // metres between trackside camera posts
const TRACKSIDE_SWITCH = 25; // switch posts when another is this much closer [m]

type View = 'cockpit' | 'chase' | 'trackside';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wStatus = $<HTMLDivElement>('status');
const hud = $<HTMLPreElement>('hud');
const controls = document.querySelector<HTMLDivElement>('.controls')!;
const steerSlider = $<HTMLInputElement>('steer');
const steerReadout = $<HTMLOutputElement>('steer-readout');
const pedalButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-pedal]')];
const dirButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-dir]')];
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
const viewButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-view]')];
const alertEl = $<HTMLDivElement>('alert');
const alertTitle = $<HTMLElement>('alert-title');
const alertSub = $<HTMLSpanElement>('alert-sub');

// Status line: remembers its i18n key so a language switch can re-render it.
let statusKey: Key = 'status.loading';
let statusColor = '#aaa';
let statusExtra = '';
function setStatus(key: Key, color: string, extra = '') {
  statusKey = key;
  statusColor = color;
  statusExtra = extra;
  renderStatus();
}
function renderStatus(live = '') {
  wStatus.innerHTML = `<span style="color:${statusColor}">${t(statusKey)}${statusExtra}</span>${live}`;
}

setLang(getLang());
setStatus('status.loading', '#aaa');

// ── Load MuJoCo, the Monaco world and textures ──
const base = import.meta.env.BASE_URL;
const texLoader = new THREE.TextureLoader();
const [mj, monaco, groundTex, satTex] = await Promise.all([
  loadMujoco({ locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) }),
  loadMonaco(async (f) => {
    const res = await fetch(`${base}monaco/${f}`);
    if (!res.ok) throw new Error(`${f}: ${res.status}`);
    return res.arrayBuffer();
  }),
  texLoader.loadAsync(`${base}monaco/ground.jpg`),
  texLoader.loadAsync(`${base}monaco/s2.jpg`),
]).catch((err) => {
  setStatus('status.error', '#f66', ` ${String(err)}`);
  throw err;
});
$('credit').textContent = monaco.world.attribution;

const sim = new CarSim(mj, monaco);
const view = new SceneView(mj, sim.model, sim.data, monaco, { ground: groundTex, satellite: satTex });
const CAM = mj.mjtObj.mjOBJ_CAMERA.value;
const chaseCamId = mj.mj_name2id(sim.model, CAM, 'chase_cam');
const cockpitCamId = mj.mj_name2id(sim.model, CAM, 'cockpit_cam');

function makeRenderer(canvas: HTMLCanvasElement) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  r.outputColorSpace = THREE.LinearSRGBColorSpace;
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  return r;
}
const mainRenderer = makeRenderer($('main-canvas'));
const overheadRenderer = makeRenderer($('overhead-canvas'));
const mainCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 20000);
const overheadCam = new THREE.PerspectiveCamera(45, 500 / 380, 1, 2000);
const lookat = new THREE.Vector3();

function fitRenderer(r: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera) {
  const el = r.domElement.parentElement!;
  const { clientWidth: w, clientHeight: h } = el;
  const size = r.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) r.setSize(w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}

// ── Cameras: cockpit, chase, trackside posts ──
let currentView: View = 'chase';

/** Spectator posts beside the track, on the outside of the nearest bend, at grandstand height. */
function tracksidePosts(tr: Track, terrainAt: (x: number, y: number) => number) {
  const posts: THREE.Vector3[] = [];
  const every = Math.round(TRACKSIDE_SPACING / tr.step);
  for (let k = 0; k < tr.n; k += every) {
    let c = 0;
    for (let j = -15; j <= 15; j++) c += tr.curvature[tr.wrap(k + j)];
    const side = c > 0 ? -1 : 1; // outside of a left bend is on the right
    const h = tr.heading[k];
    const off = tr.halfWidth + 9;
    const x = tr.x[k] - Math.sin(h) * off * side;
    const y = tr.y[k] + Math.cos(h) * off * side;
    posts.push(new THREE.Vector3(x, y, Math.max(tr.z[k], terrainAt(x, y)) + 4));
  }
  return posts;
}
const nearGrid = monaco.world.near;
const posts = tracksidePosts(monaco.track, (x, y) => {
  const i = Math.round((x - nearGrid.e0) / nearGrid.cell), j = Math.round((y - nearGrid.n0) / nearGrid.cell);
  if (i < 0 || j < 0 || i >= nearGrid.nx || j >= nearGrid.ny) return 0;
  return monaco.near[j * nearGrid.nx + i];
});
let postIdx = 0;

function placeMainCamera(pos: number[]) {
  if (currentView === 'cockpit') view.setFromModelCamera(mainCam, cockpitCamId);
  else if (currentView === 'chase') view.setFromModelCamera(mainCam, chaseCamId);
  else {
    const car = lookat.set(pos[0], pos[1], pos[2] + 0.3);
    let best = postIdx;
    for (let i = 0; i < posts.length; i++) {
      if (posts[i].distanceTo(car) < posts[best].distanceTo(car)) best = i;
    }
    if (posts[best].distanceTo(car) + TRACKSIDE_SWITCH < posts[postIdx].distanceTo(car)) postIdx = best;
    const p = posts[postIdx];
    const d = p.distanceTo(car);
    mainCam.position.copy(p);
    mainCam.up.set(0, 0, 1);
    mainCam.lookAt(car);
    // Zoom like a TV camera: keep the car roughly the same size on screen.
    mainCam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(9 / d)), 6, 60);
    mainCam.updateProjectionMatrix();
    mainCam.updateMatrixWorld();
  }
}

function renderMain(pos: number[]) {
  fitRenderer(mainRenderer, mainCam);
  placeMainCamera(pos);
  view.aimHeadlight(mainCam);
  mainRenderer.render(view.scene, mainCam);
}

function renderOverhead(pos: number[], yaw: number) {
  fitRenderer(overheadRenderer, overheadCam);
  lookat.set(pos[0], pos[1], pos[2]);
  setFreeCamera(overheadCam, lookat, OVERHEAD_DISTANCE, THREE.MathUtils.radToDeg(yaw) + 90.0, -88);
  view.aimHeadlight(overheadCam);
  overheadRenderer.render(view.scene, overheadCam);
}

// ── HUD ──
const fmtTime = (s: number | null) => {
  if (s === null) return '--:--.---';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};
const signed = (n: number, digits: number) => (n >= 0 ? '+' : '') + n.toFixed(digits);
const DIR_COLOR: Record<Direction, string> = {
  forward: 'rgb(80,255,100)', reverse: 'rgb(255,160,60)', stop: 'rgb(200,200,200)',
};
const PEDAL_KEY: Record<Pedal, Key | null> = { accel: 'hud.accel', hold: 'hud.hold', brake: 'hud.brake', none: null };
const label = (k: Key) => t(k).padEnd(getLang() === 'ja' ? 4 : 6);

function updateHud(speed: number) {
  const st = sim.state;
  const ls = sim.lapState;
  const lapTime = ls.lap > 0 ? sim.data.time - ls.lapStart : null;
  const pedal = PEDAL_KEY[st.pedal];
  const dir = st.direction === 'forward' ? 'hud.forward' : st.direction === 'reverse' ? 'hud.reverse' : 'hud.stop';
  hud.innerHTML =
    `<span style="color:rgb(100,255,130)">${label('hud.speed')}: ${(Math.abs(speed) * 3.6).toFixed(0).padStart(4)} km/h</span>\n` +
    `<span style="color:rgb(255,220,120)">${label('hud.lap')}: ${ls.lap > 0 ? ls.lap : t('hud.grid')}</span>\n` +
    `<span style="color:#fff">${label('hud.time')}: ${fmtTime(lapTime)}</span>\n` +
    `<span class="small" style="color:#ccc">${label('hud.last')}: ${fmtTime(ls.last)}</span>\n` +
    `<span class="small" style="color:rgb(200,160,255)">${label('hud.best')}: ${fmtTime(ls.best)}</span>\n` +
    `<span class="small" style="color:rgb(100,200,255)">${label('hud.steer')}: ${signed(THREE.MathUtils.radToDeg(st.steerCmd), 1).padStart(6)} °</span>\n` +
    `<span class="small" style="color:#aaa">${label('hud.mode')}: ${t(st.mode === 'demo' ? 'hud.demo' : 'hud.manual')}` +
    (st.mode === 'manual'
      ? ` · <span style="color:${DIR_COLOR[st.direction]}">${t(dir)}</span>${pedal ? ` · ${t(pedal)}` : ''}`
      : '') +
    '</span>';
}

function drawFrame() {
  view.sync();
  const { pos, yaw, speed } = sim.pose();
  renderMain(pos);
  renderOverhead(pos, yaw);
  updateHud(speed);
  if (running) renderStatus(` &nbsp;<b style="color:#ff9">${(Math.abs(speed) * 3.6).toFixed(0)} km/h</b>`);
}

// ── Warning overlay + alert sound (barrier contact, map edge, rollover) ──
const ALERT_TEXT: Record<Hit, [Key, Key]> = {
  barrier: ['alert.barrier', 'alert.barrier.sub'],
  boundary: ['alert.boundary', 'alert.boundary.sub'],
  rollover: ['alert.rollover', 'alert.rollover.sub'],
};
let audio: AudioContext | null = null;
let alertUntil = 0;
let alertKind: Hit | null = null;

/** Create / resume the AudioContext; browsers only allow this from a user gesture. */
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

function beep(t0: number) {
  if (!audio) return;
  const gain = audio.createGain();
  gain.connect(audio.destination);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
  gain.gain.setValueAtTime(0.18, t0 + 0.28);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
  const osc = audio.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, t0);
  osc.frequency.setValueAtTime(660, t0 + 0.15);
  osc.connect(gain);
  osc.start(t0);
  osc.stop(t0 + 0.33);
}

function beepAlarm() {
  if (!audio) return;
  for (let i = 0; i < BEEP_COUNT; i++) beep(audio.currentTime + i * BEEP_SPACING_S);
}

function renderAlert() {
  if (!alertKind) return;
  const [title, sub] = ALERT_TEXT[alertKind];
  alertTitle.textContent = t(title);
  alertSub.textContent = t(sub);
}

function showAlert(kind: Hit, until: number) {
  alertKind = kind;
  renderAlert();
  alertEl.hidden = false;
  alertUntil = until;
}

function updateAlert(now: number) {
  if (sim.hits.size) {
    const kind: Hit = sim.hits.has('barrier') ? 'barrier' : 'boundary';
    sim.hits.clear();
    // Alarm once per warning; continued contact only keeps the overlay up.
    if (alertEl.hidden) beepAlarm();
    showAlert(kind, now + ALERT_HOLD_MS);
  } else if (!alertEl.hidden && now >= alertUntil) {
    alertEl.hidden = true;
    alertKind = null;
  }
}

function clearAlert() {
  sim.hits.clear();
  alertEl.hidden = true;
  alertKind = null;
  alertUntil = 0;
}

// ── Main loop: physics in real time while running, display every animation frame ──
let running = false;
let lastT = 0;
let acc = 0;

function tick(now: number) {
  if (running) {
    acc += Math.min((now - lastT) / 1000, MAX_STEPS_PER_FRAME * SIM_DT);
    lastT = now;
    while (acc >= SIM_DT && !sim.isRolledOver()) {
      sim.step();
      acc -= SIM_DT;
    }
    if (sim.isRolledOver()) onRollover();
    else updateAlert(now);
  }
  drawFrame();
  requestAnimationFrame(tick);
}

/** Car tipped over: stop the sim and keep the warning up until Reset. */
function onRollover() {
  running = false;
  sim.zeroCtrl();
  sim.hits.clear();
  setPedal('none');
  showAlert('rollover', Infinity);
  beepAlarm();
  setStatus('status.rolled', '#f66');
}

function onStart() {
  unlockAudio();
  if (running) return;
  if (sim.isRolledOver()) {
    onRollover();
    return;
  }
  running = true;
  acc = 0;
  lastT = performance.now();
  setStatus('status.running', '#6f6');
}

function onStop() {
  running = false;
  sim.zeroCtrl();
  setPedal('none');
  clearAlert();
  setStatus('status.stopped', '#f96');
}

function onReset() {
  running = false;
  sim.reset();
  clearAlert();
  setSteer(0);
  setPedal('none');
  syncButtons();
  postIdx = 0;
  setStatus('status.reset', '#aaf');
}

// ── Steering slider (slider right → steer right, i.e. negative yaw) ──
function setSteer(v: number) {
  v = THREE.MathUtils.clamp(v, -MAX_STEER_RAD, MAX_STEER_RAD);
  steerSlider.value = String(v);
  onSteerInput();
}
function onSteerInput() {
  const v = Number(steerSlider.value);
  steerReadout.value = v.toFixed(2);
  sim.state.steer = -v;
}
steerSlider.addEventListener('input', onSteerInput);

// ── Segmented buttons ──
function syncButtons() {
  for (const b of dirButtons) b.classList.toggle('selected', b.dataset.dir === sim.state.direction);
  for (const b of modeButtons) b.classList.toggle('selected', b.dataset.mode === sim.state.mode);
  for (const b of viewButtons) b.classList.toggle('selected', b.dataset.view === currentView);
  controls.classList.toggle('demo', sim.state.mode === 'demo');
}
function setDir(d: Direction) {
  sim.state.direction = d;
  syncButtons();
}
for (const b of dirButtons) b.addEventListener('click', () => setDir(b.dataset.dir as Direction));

function setMode(m: DriveMode) {
  if (m === sim.state.mode) return;
  sim.state.mode = m;
  if (m === 'manual') {
    // Take over smoothly: keep rolling at the current speed, wheels straight.
    setSteer(0);
    sim.state.direction = 'forward';
    setPedal(sim.state.wheelVel > 0 ? 'hold' : 'none');
  }
  syncButtons();
}
for (const b of modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode as DriveMode));

function setView(v: View) {
  currentView = v;
  syncButtons();
}
for (const b of viewButtons) b.addEventListener('click', () => setView(b.dataset.view as View));
const VIEWS: View[] = ['cockpit', 'chase', 'trackside'];

// ── Pedal buttons: ACCEL / HOLD / BRAKE are mutually exclusive; pressing the active one releases it ──
function setPedal(p: Pedal) {
  sim.state.pedal = p;
  for (const b of pedalButtons) b.setAttribute('aria-pressed', String(b.dataset.pedal === p));
}
const togglePedal = (p: Pedal) => setPedal(sim.state.pedal === p ? 'none' : p);
for (const b of pedalButtons) b.addEventListener('click', () => togglePedal(b.dataset.pedal as Pedal));

$('start').addEventListener('click', onStart);
$('stop').addEventListener('click', onStop);
$('reset').addEventListener('click', onReset);
const toggleLang = () => setLang(getLang() === 'en' ? 'ja' : 'en');
$('lang').addEventListener('click', toggleLang);
const helpLink = $<HTMLAnchorElement>('help');
const syncHelpLink = () => (helpLink.href = `manual.html?lang=${getLang()}`);
syncHelpLink();
onLangChange(() => {
  syncHelpLink();
  renderStatus();
  renderAlert();
});

// ── Keyboard shortcuts mirroring the buttons ──
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.key.startsWith('Arrow')) return; // slider handles its own arrows
  const manual = sim.state.mode === 'manual';
  switch (e.key) {
    case 'ArrowLeft': if (manual) setSteer(Number(steerSlider.value) - 0.04); break;
    case 'ArrowRight': if (manual) setSteer(Number(steerSlider.value) + 0.04); break;
    case 'c': case 'C': if (manual) setSteer(0); break;
    case 'f': case 'F': if (manual) setDir('forward'); break;
    case 's': case 'S': if (manual) setDir('stop'); break;
    case 'r': case 'R': if (manual) setDir('reverse'); break;
    case ' ': case 'w': case 'W': if (manual) togglePedal('accel'); break;
    case 'h': case 'H': if (manual) togglePedal('hold'); break;
    case 'b': case 'B': if (manual) togglePedal('brake'); break;
    case 'v': case 'V': setView(VIEWS[(VIEWS.indexOf(currentView) + 1) % VIEWS.length]); break;
    case 'm': case 'M': setMode(manual ? 'demo' : 'manual'); break;
    case 'l': case 'L': toggleLang(); break;
    default: return;
  }
  e.preventDefault();
});

// URL options, e.g. ?mode=demo&view=trackside&lang=ja&autostart
const params = new URLSearchParams(location.search);
const pLang = params.get('lang'), pMode = params.get('mode'), pView = params.get('view');
if (pLang === 'en' || pLang === 'ja') setLang(pLang);
if (pMode === 'manual' || pMode === 'demo') setMode(pMode);
if (pView && (VIEWS as string[]).includes(pView)) currentView = pView as View;

syncButtons();
setStatus('status.ready', '#aaa');
if (params.has('autostart')) onStart();
requestAnimationFrame(tick);
