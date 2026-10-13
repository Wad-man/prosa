// App-level user settings: the theme (light/dark, persisted under
// prosa.theme) and the interface-language switch. The language state itself
// (the prosa.lang key, autodetection and the string dictionaries) lives in
// i18n.ts — this module only flips it and notifies the app. The stored theme
// is applied at cold start by an inline script in index.html (before first
// paint, to avoid a flash); every runtime switch goes through here.
import { getLang, setLang, type Lang } from './i18n';
import { storageSet } from './storage';

const THEME_KEY = 'prosa.theme';

// Runtime switches fade instead of snapping (#106): applyTheme plants a
// one-shot .theme-fade class on <html> (styles.css turns every color into a
// var(--t-theme) transition) and drops it after the transition ends, so
// nothing else ever animates. Cold start (the index.html inline script)
// never passes through here — no fade on launch.
const THEME_FADE_MS = 340; // var(--t-theme) 280ms + a frame of slack
let themeFadeTimer = 0;

export function applyTheme(theme: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) fadeThemeSwitch();
  root.dataset.theme = theme;
  storageSet(THEME_KEY, theme);
}

/** Plant the fade class unless the user asked for reduced motion — the
 * class CSS would otherwise override the global reduced-motion reset. */
function fadeThemeSwitch(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  root.classList.add('theme-fade');
  window.clearTimeout(themeFadeTimer);
  themeFadeTimer = window.setTimeout(() => root.classList.remove('theme-fade'), THEME_FADE_MS);
}

/** The theme currently applied to <html data-theme>; "light" when unset. */
export function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** The #btn-theme action: flip and persist the current theme. */
export function toggleTheme(): void {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
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
