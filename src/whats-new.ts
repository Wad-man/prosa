/**
 * «What's new» (#37): a notification dot on the Help menu after the app
 * updated (a stored viewed version differing from the running one — a
 * plain inequality, so RC↔stable transitions count too) and a modal with
 * the current release's summary. A fresh install records the version
 * silently, no dot. The dot survives restarts until the modal is viewed.
 *
 * The summary lives here — not in i18n.ts — to keep prose out of the UI
 * string table; it is refreshed every release. The link points to the
 * site's changelog with the `from=prosamd` label (Метрика segments by
 * full URL, no utm machinery needed).
 */
import { storageGet, storageSet } from './storage';
import type { Lang } from './i18n';

const KEY = 'prosa.whats-new';

/**
 * Whether the install predates the whats-new key — captured at module
 * load, BEFORE init() runs initZoom(), which writes prosa.zoom on every
 * boot; reading storage inside checkWhatsNew would then light the dot
 * for fresh installs too (control-round BLOCK). A user updating from
 * ≤ rc.4 carries these keys from previous runs; a brand-new profile has
 * none at import time.
 */
const HAD_PRIOR_STATE =
  storageGet('prosa.lang') !== null ||
  storageGet('prosa.theme') !== null ||
  storageGet('prosa.zoom') !== null ||
  storageGet('prosa.features') !== null;

export const CHANGELOG_URL = 'https://prosamd.ru/changelog.html';

/** User-facing summary of the current release, refreshed per release. */
const RELEASE_SUMMARY: Record<Lang, string[]> = {
  ru: [
    'Печать — Ctrl+P, сохранение в PDF — Ctrl+Shift+P (Windows); на macOS и Linux PDF — из диалога печати',
    'Настройки (Ctrl+,), поиск и замена, Raw HTML, масштаб, «Скопировать для Word»',
    'Сборки для Linux (AppImage, deb); macOS — отдельной версией (prosa-mac)',
    'Диалог «Справка» (F1) со всеми горячими клавишами',
  ],
  en: [
    'Print — Ctrl+P, save as PDF — Ctrl+Shift+P (Windows); on macOS and Linux save the PDF from the print dialog',
    'Settings (Ctrl+,), find & replace, raw HTML, zoom, "Copy for Word"',
    'Linux (AppImage, deb) builds; macOS ships as a separate version (prosa-mac)',
    'The Help dialog (F1) with every keyboard shortcut',
  ],
};

export function whatsNewItems(lang: Lang): string[] {
  return RELEASE_SUMMARY[lang];
}

/**
 * Decide whether the «What's new» dot should light up. Returns the
 * verdict through the callback (`pending: true` = updated since the last
 * view). A first run just records the version — with one upgrade carve-out
 * (review M2): a user updating from a build that predated this key (≤ rc.4)
 * has no `prosa.whats-new`, but carries other prosa.* keys from past runs;
 * the debut release must still show them the dot. The snapshot is taken at
 * module load (see HAD_PRIOR_STATE): no keys at import time = a genuinely
 * fresh install.
 */
export function checkWhatsNew(appVersion: string, onPending: (pending: boolean) => void): void {
  if (!appVersion) return;
  const seen = storageGet(KEY);
  if (seen === null) {
    storageSet(KEY, appVersion);
    if (HAD_PRIOR_STATE) onPending(true);
    return;
  }
  onPending(seen !== appVersion);
}

/** The modal was opened — the current version counts as viewed now. */
export function markWhatsNewSeen(appVersion: string): void {
  if (appVersion) storageSet(KEY, appVersion);
}
