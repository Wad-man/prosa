// App-level user settings: the theme (light/dark, persisted under
// prosa.theme) and the interface-language toggle. The language state itself
// (the prosa.lang key, autodetection and the string dictionaries) lives in
// i18n.ts — this module only flips it. The stored theme is applied at cold
// start by an inline script in index.html (before first paint, to avoid a
// flash); every runtime switch goes through here.
import { getLang, setLang } from './i18n';

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

/** The #btn-lang action: flip RU/EN. Re-applying the UI strings and
 * rebuilding the visual editor (Crepe bakes its locale in at construction)
 * stays with the #btn-lang listener in main.ts. */
export function toggleLang(): void {
  setLang(getLang() === 'ru' ? 'en' : 'ru');
}
