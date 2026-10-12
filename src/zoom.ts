// App-level zoom (#25): Ctrl+wheel in/out, Ctrl+= / Ctrl+−, Ctrl+Num0 to
// reset, persisted under prosa.zoom. Applied as the CSS `zoom` property on
// <html> — one knob the whole UI (chrome, editors, dialogs) scales with,
// supported by all three web engines (WebView2 / WKWebView / WebKitGTK).
//
// tauri.conf.json sets zoomHotkeysEnabled: false, so WebView2's own
// Ctrl+±/Ctrl+0 zoom never races this one; the wheel gesture is claimed
// here with preventDefault (Chromium respects that for ctrl+wheel).
const ZOOM_KEY = 'prosa.zoom';
const MIN = 0.5;
const MAX = 2.0;
const STEP = 0.1;
// one notch of a physical wheel is ~100 deltaY — one notch = one ladder
// step; trackpad pinches fire many tiny events that accumulate to it
const WHEEL_THRESHOLD = 100;

let level = loadLevel();
let wheelAcc = 0;
let lastWheelAt = 0;

function loadLevel(): number {
  const stored = Number.parseFloat(localStorage.getItem(ZOOM_KEY) ?? '');
  if (!Number.isFinite(stored)) return 1;
  return clamp(round(stored));
}

function clamp(v: number): number {
  return Math.min(MAX, Math.max(MIN, v));
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function apply(): void {
  document.documentElement.style.zoom = level.toFixed(2);
  localStorage.setItem(ZOOM_KEY, String(level));
}

function step(dir: 1 | -1): void {
  const next = clamp(round(level + dir * STEP));
  if (next === level) return;
  level = next;
  apply();
}

/** Applied zoom as a number (1 when unset/broken) — popup positioning
 * divides its VISUAL coordinates (getBoundingClientRect, clientX/Y) by it:
 * those come zoom-multiplied, while style.left/top of an element inside the
 * zoomed <html> expect unzoomed CSS px (double-scaling otherwise). */
export function cssZoom(): number {
  const z = Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1');
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Called once from main.ts: applies the stored level and claims the wheel. */
export function initZoom(): void {
  apply();
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // a fresh gesture (>300 ms gap) starts from zero — leftover sub-step
      // accumulation must not make the first notch feel oversensitive
      const now = performance.now();
      if (now - lastWheelAt > 300) wheelAcc = 0;
      lastWheelAt = now;
      wheelAcc += e.deltaY;
      while (wheelAcc <= -WHEEL_THRESHOLD) {
        step(1); // wheel up / pinch out — zoom in, the browser convention
        wheelAcc += WHEEL_THRESHOLD;
      }
      while (wheelAcc >= WHEEL_THRESHOLD) {
        step(-1);
        wheelAcc -= WHEEL_THRESHOLD;
      }
    },
    { passive: false, capture: true },
  );
}

export function zoomIn(): void {
  step(1);
}

export function zoomOut(): void {
  step(-1);
}

export function zoomReset(): void {
  if (level === 1) return;
  level = 1;
  apply();
}
