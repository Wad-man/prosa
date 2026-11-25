// App-level user settings: the theme mode (light/dark/system, persisted
// under prosa.theme) and the interface-language switch. The language state
// itself (the prosa.lang key, autodetection and the string dictionaries)
// lives in i18n.ts — this module only flips it and notifies the app. The
// stored mode is applied at cold start by an inline script in index.html
// (before first paint, to avoid a flash); every runtime switch goes through
// here.
import { getLang, setLang, type Lang } from './i18n';
import { storageGet, storageSet } from './storage';

const THEME_KEY = 'prosa.theme';

// #172: three modes. "system" follows the OS prefers-color-scheme live
// (one matchMedia listener for the whole session, below); light/dark are
// pinned. The stored value is the MODE — an absent key reads as "system",
// which is the same first-run behavior the app always had, only
// live-following now instead of sniffed once at first paint.
export type ThemeMode = 'light' | 'dark' | 'system';

// #106 → owner gate 2026-10-15: the switch is a single compositor wipe of
// the whole window FROM THE TOGGLE BUTTON — slow (600ms) and ease-in-out on
// purpose: the eye reads a quick crossfade as a flash, and a dark→light
// snap is harsh. The View Transitions API snapshots the window once, so
// nothing per-element animates (the old #106 transition-on-* mechanism and
// its repaint jank are gone entirely). Where the API is missing (WebKitGTK
// on older Linux) or the user asked for reduced motion, the flip is instant.
type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown;
};

/** Where the wipe begins — the toggle button's center in viewport px. */
export interface ThemeOrigin {
  x: number;
  y: number;
}

/** The stored mode; an absent (or foreign) value reads as "system". */
export function themeMode(): ThemeMode {
  const stored = storageGet(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** The OS scheme right now — the "system" mode's source of truth. */
function osTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** DOM flip + wipe only — no storage write. The mode write belongs to the
 *  explicit user action (setThemeMode); an ambient OS flip
 *  must not pin the theme (#172). */
function applyResolved(theme: 'light' | 'dark', origin?: ThemeOrigin): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const flip = (): void => {
    root.dataset.theme = theme;
  };
  const doc = document as ViewTransitionCapableDocument;
  const canWipe =
    typeof doc.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (origin) {
    root.style.setProperty('--theme-origin-x', `${origin.x}px`);
    root.style.setProperty('--theme-origin-y', `${origin.y}px`);
  } else {
    // menu-triggered switches have no button — wipe from the center, not
    // from the stale coordinates of an earlier button click
    root.style.removeProperty('--theme-origin-x');
    root.style.removeProperty('--theme-origin-y');
  }
  if (canWipe) doc.startViewTransition!(flip);
  else flip();
}

/** #172: pick a mode — the Settings segmented control and the «Вид» menu
 *  items land here. Persists the mode and applies its resolved theme; the
 *  origin (the pressed segment) starts the wipe. */
export function setThemeMode(mode: ThemeMode, origin?: ThemeOrigin): void {
  storageSet(THEME_KEY, mode);
  applyResolved(mode === 'system' ? osTheme() : mode, origin);
}

// While in "system" the window follows the OS live. One listener for the
// whole session (the K6 #163 discipline — nothing per-switch); the wipe
// grows from the center like menu-triggered switches (no origin).
if (typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const follow = (): void => {
    if (themeMode() === 'system') applyResolved(mq.matches ? 'dark' : 'light');
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', follow);
  else mq.addListener(follow); // pre-Safari-14 / older WebKitGTK
}

// ---------- interface language (#88) ----------

// main.ts registers the switch machinery once (re-apply every live string,
// refresh the chrome, rebuild the visual editor — Crepe bakes its locale in
// at construction); UI entry points — today the Settings dialog — only call
// setLanguage and stay dumb, so the live switch is never duplicated.

/** Listeners run after the language flips; registered by main.ts. */
const langListeners: Array<() => void> = [];

export function onLangChanged(listener: () => void): void {
  langListeners.push(listener);
}

/** Switch the UI language and notify (the old #btn-lang flip, now shared by
 * every entry point). Re-selecting the active language only pins it in
 * storage (an autodetected lang becomes explicit) — the Crepe rebuild
 * resets the undo history and must not run for nothing. */
export function setLanguage(lang: Lang): void {
  if (getLang() === lang) {
    setLang(lang);
    return;
  }
  setLang(lang);
  for (const listener of langListeners) listener();
}

// ---------- automatic update check (#160) ----------

// Whether the app checks for updates on its own shortly after startup. The
// manual «Check for updates» in «About» is independent of this. Absent key
// = on: checking is the default, opting out is an explicit act.
const AUTO_UPDATE_KEY = 'prosa.updates.auto';

export function autoUpdateEnabled(): boolean {
  return storageGet(AUTO_UPDATE_KEY) !== '0';
}

export function setAutoUpdateEnabled(on: boolean): void {
  storageSet(AUTO_UPDATE_KEY, on ? '1' : '0');
}

// ---------- opening mode (#178) ----------

// The mode a file opens in: every fresh document landing from disk (open
// dialog, double-click, drop, recents, cold start) enters it. The stored
// value overrides the window's current mode — that override is the point
// of the setting (owner feedback: open in Просмотр without touching each
// file). Tab switches and reloads keep a document's own mode; Ctrl+N and
// the empty window stay in the editor. Absent key = "visual", the cold
// start mode the app always had — opting out is an explicit act, same
// policy as AUTO_UPDATE_KEY above.
const OPEN_MODE_KEY = 'prosa.openMode';

export type OpenMode = 'reading' | 'visual' | 'source' | 'split';

export function openingMode(): OpenMode {
  const stored = storageGet(OPEN_MODE_KEY);
  return stored === 'reading' || stored === 'source' || stored === 'split' ? stored : 'visual';
}

export function setOpeningMode(mode: OpenMode): void {
  storageSet(OPEN_MODE_KEY, mode);
}
