// App-level user settings: the theme (light/dark, persisted under
// prosa.theme) and the interface-language switch. The language state itself
// (the prosa.lang key, autodetection and the string dictionaries) lives in
// i18n.ts — this module only flips it and notifies the app. The stored theme
// is applied at cold start by an inline script in index.html (before first
// paint, to avoid a flash); every runtime switch goes through here.
import { getLang, setLang, type Lang } from './i18n';
import { storageGet, storageSet } from './storage';

const THEME_KEY = 'prosa.theme';

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

export function applyTheme(theme: 'light' | 'dark', origin?: ThemeOrigin): void {
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
  storageSet(THEME_KEY, theme);
}

/** The theme currently applied to <html data-theme>; "light" when unset. */
export function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** The #btn-theme action: flip and persist the current theme. The origin
 *  (button center) starts the wipe; without one it grows from the center. */
export function toggleTheme(origin?: ThemeOrigin): void {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', origin);
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
