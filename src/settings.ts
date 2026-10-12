// App-level user settings: the theme (light/dark, persisted under
// prosa.theme) and the interface-language switch. The language state itself
// (the prosa.lang key, autodetection and the string dictionaries) lives in
// i18n.ts — this module only flips it and notifies the app. The stored theme
// is applied at cold start by an inline script in index.html (before first
// paint, to avoid a flash); every runtime switch goes through here.
import { getLang, setLang, type Lang } from './i18n';

const THEME_KEY = 'prosa.theme';

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
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
