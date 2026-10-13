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

export const CHANGELOG_URL = 'https://prosamd.ru/changelog.html';

/** User-facing summary of the current release, refreshed per release. */
const RELEASE_SUMMARY: Record<Lang, string[]> = {
  ru: [
    'Печать и экспорт в PDF: Ctrl+P, тихий PDF на Windows, системный лист на macOS и Linux',
    'Настройки (Ctrl+,), поиск и замена, Raw HTML, масштаб, «Скопировать для Word»',
    'Сборки для macOS (universal) и Linux (AppImage, deb)',
    'Диалог «Справка» (F1) со всеми горячими клавишами',
  ],
  en: [
    'Print & PDF export: Ctrl+P — silent PDF on Windows, system print sheet on macOS and Linux',
    'Settings (Ctrl+,), find & replace, raw HTML, zoom, "Copy for Word"',
    'macOS (universal) and Linux (AppImage, deb) builds',
    'The Help dialog (F1) with every keyboard shortcut',
  ],
};

export function whatsNewItems(lang: Lang): string[] {
  return RELEASE_SUMMARY[lang];
}

/**
 * Decide whether the «What's new» dot should light up. Returns the
 * verdict through the callback (`pending: true` = updated since the last
 * view); a first run just records the version.
 */
export function checkWhatsNew(appVersion: string, onPending: (pending: boolean) => void): void {
  if (!appVersion) return;
  const seen = storageGet(KEY);
  if (seen === null) {
    storageSet(KEY, appVersion);
    return;
  }
  onPending(seen !== appVersion);
}

/** The modal was opened — the current version counts as viewed now. */
export function markWhatsNewSeen(appVersion: string): void {
  if (appVersion) storageSet(KEY, appVersion);
}
