// English / Japanese UI strings. Static text uses data-i18n (textContent) and
// data-i18n-title (tooltip) attributes; dynamic text calls t().

export type Lang = 'en' | 'ja';

const DICT = {
  'title': ['Monaco Street Circuit', 'モナコ市街地サーキット'],
  'overhead': ['🌐 Overhead Map', '🌐 上空マップ'],
  'mode.manual': ['🎮 Manual', '🎮 手動'],
  'mode.demo': ['🤖 Demo', '🤖 デモ'],
  'mode.title': ['Driving mode (M)', '走行モード (M)'],
  'view.cockpit': ['🪖 Cockpit', '🪖 運転席'],
  'view.chase': ['🚗 Chase', '🚗 後方'],
  'view.trackside': ['🎥 Trackside', '🎥 定点'],
  'view.title': ['Camera (V)', 'カメラ (V)'],
  'steer.title': ['Steer (←/→, C to center)', 'ステア (←/→、C で中央)'],
  'dir.forward': ['▶ FWD', '▶ 前進'],
  'dir.forward.title': ['Forward (F)', '前進 (F)'],
  'dir.stop.title': ['Stop (S)', '停止 (S)'],
  'dir.reverse': ['◀ REV', '◀ 後退'],
  'dir.reverse.title': ['Reverse (R)', '後退 (R)'],
  'pedal.accel': ['🔺 ACCEL', '🔺 加速'],
  'pedal.accel.title': ['Accelerate (Space / W)', '加速 (Space / W)'],
  'pedal.hold': ['⏸ HOLD', '⏸ 維持'],
  'pedal.hold.title': ['Hold current speed (H)', '速度維持 (H)'],
  'pedal.brake': ['🔻 BRAKE', '🔻 減速'],
  'pedal.brake.title': ['Decelerate (B)', '減速 (B)'],
  'sim.start': ['▶ Start', '▶ 開始'],
  'sim.start.title': ['Start simulation', 'シミュレーション開始'],
  'sim.stop': ['■ Stop', '■ 停止'],
  'sim.stop.title': ['Stop simulation', 'シミュレーション停止'],
  'sim.reset.title': ['Back to the grid', 'スタート位置に戻す'],
  'lang.title': ['Language (L)', '表示言語 (L)'],
  'help.title': ['User manual', '使用マニュアル'],
  'status.loading': ['Loading Monaco…', 'モナコを読み込み中…'],
  'status.ready': ['Press ▶ Start to begin', '▶ 開始 を押してください'],
  'status.running': ['▶ Running', '▶ 走行中'],
  'status.stopped': ['■ Stopped', '■ 停止中'],
  'status.reset': ['↺ Back on the grid — press ▶ Start', '↺ スタート位置 — ▶ 開始 を押してください'],
  'status.rolled': ['⚠ Rolled over — press ↺ Reset', '⚠ 転倒 — ↺ でリセット'],
  'status.error': ['Failed to load: ', '読み込みに失敗しました: '],
  'alert.barrier': ['⚠ CRASH', '⚠ クラッシュ'],
  'alert.barrier.sub': ['You hit the barrier', 'ガードレールに接触しました'],
  'alert.boundary': ['⚠ OUT OF BOUNDS', '⚠ 範囲外'],
  'alert.boundary.sub': ['Edge of the map — no way through', 'マップの端です — これ以上進めません'],
  'alert.rollover': ['⚠ ROLLOVER', '⚠ 転倒'],
  'alert.rollover.sub': ['The car rolled over — press ↺ Reset', '車両が転倒しました — ↺ を押してください'],
  'hud.speed': ['Speed', '速度'],
  'hud.lap': ['Lap', '周回'],
  'hud.time': ['Time', 'タイム'],
  'hud.last': ['Last', '前周'],
  'hud.best': ['Best', 'ベスト'],
  'hud.steer': ['Steer', 'ステア'],
  'hud.dir': ['Dir', '方向'],
  'hud.pedal': ['Pedal', 'ペダル'],
  'hud.mode': ['Mode', 'モード'],
  'hud.grid': ['grid', 'スタート前'],
  'hud.forward': ['▶ FORWARD', '▶ 前進'],
  'hud.reverse': ['◀ REVERSE', '◀ 後退'],
  'hud.stop': ['■ STOP', '■ 停止'],
  'hud.accel': ['🔺ACCEL', '🔺加速'],
  'hud.hold': ['⏸HOLD', '⏸維持'],
  'hud.brake': ['🔻BRAKE', '🔻減速'],
  'hud.manual': ['MANUAL', '手動'],
  'hud.demo': ['DEMO', 'デモ'],
} as const satisfies Record<string, readonly [string, string]>;

export type Key = keyof typeof DICT;

const STORE_KEY = 'monaco-lang';
let lang: Lang = initialLang();
const listeners: (() => void)[] = [];

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'en' || saved === 'ja') return saved;
  } catch {
    // storage unavailable
  }
  return navigator.language.startsWith('ja') ? 'ja' : 'en';
}

export const getLang = () => lang;
export const t = (key: Key) => DICT[key][lang === 'en' ? 0 : 1];

export function onLangChange(fn: () => void) {
  listeners.push(fn);
}

/** Apply the language to every data-i18n / data-i18n-title element and notify listeners. */
export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem(STORE_KEY, l);
  } catch {
    // storage unavailable
  }
  document.documentElement.lang = l;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key);
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle as Key);
  }
  document.title = t('title');
  for (const fn of listeners) fn();
}
