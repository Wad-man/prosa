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

/** User-facing summary of the current release, refreshed per release.
 *
 * STYLE RULES for this list (owner-approved 2026-10-16 — keep them with
 * the code, this window is NOT the GitHub release notes):
 * - one line per item, as short as possible; the verb leads where it
 *   reads naturally («Добавлены…», «Новый…»); trim the wording, never
 *   cut items to make room
 * - user-facing changes only — no technical items, no internals
 * - hotkeys in parentheses, only the essential ones
 * - the details live on the site (prosamd.ru/changelog), not here
 * - «нажатие», not «щелчок»/«клик»; RU and EN stay mirrored
 * - order follows value for the UPGRADING user, not release headlines
 * - reviewed by copywriter + tech writer + product before the owner
 *   signs off; GitHub release notes follow their own rules
 *   (prosa-changelog skill), this window does not replace them. */
const RELEASE_SUMMARY: Record<Lang, string[]> = {
  ru: [
    'Открытые файлы — ещё и полосой вкладок: переключение, перетаскивание, × у каждой вкладки, кнопка «+» и двойное нажатие по пустому месту.',
    'Колонка открытых файлов анимирована; меню «Файл» показывает недавние файлы.',
    'Несколько документов в одном окне: список открытых слева, нажатие переключает документ.',
    'Двойное нажатие файла в Проводнике открывает его в последнем активном окне ProsaMD.',
    'В диалоге «Открыть» и в Проводнике можно выделить несколько файлов — все откроются в одном окне.',
    'Добавлена поддержка выносок Obsidian (> [!note], > [!warning] и другие).',
    'Широкие таблицы и блоки кода используют всю ширину окна.',
    'В настройках — тумблер автоматической проверки обновлений.',
    'Значок × и меню списка: закрыть документ, закрыть все; при несохранённых изменениях — подтверждение.',
    'Исправления: зависание «Закрыть все», открытие из Проводника, браузерное меню вне редактора, кнопка оглавления в документе без заголовков.',
  ],
  en: [
    'Open files now also live in a tab strip: switch, drag to reorder, × on every tab, the + button and a double-click on the empty space.',
    'The open-files column is animated; the File menu lists recent files.',
    'Several documents in one window: the open-files list on the left; pressing an entry switches documents.',
    'Double-clicking a file in Explorer opens it in the last active ProsaMD window.',
    'The Open dialog and Explorer accept selecting several files — all open in one window.',
    'Added Obsidian callouts (> [!note], > [!warning] and more).',
    'Wide tables and code blocks now span the full window width.',
    'Settings gained a toggle for the automatic update check.',
    'The × icon and the list menu: close a document, close all; unsaved changes ask to confirm.',
    'Fixes: the "Close all" freeze, opening files from Explorer, the browser menu outside the editor, the outline toggle in a document without headings.',
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
