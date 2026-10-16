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
    'Режимы Просмотр, Визуальный, Код и Сплит — в одном переключателе; Ctrl+/ переключает Просмотр и редактирование.',
    'Оглавление перемещено вправо; кнопка вызова — вверху справа.',
    'Добавлены поиск и замена (Ctrl+F / Ctrl+H).',
    'Добавлены печать и сохранение в PDF.',
    'Новый стартовый экран.',
    'Добавлено масштабирование (Ctrl+колесо, Ctrl+= / Ctrl+−).',
    'Добавлено отображение HTML-тегов kbd, sub, sup, br; блочный HTML — кодом.',
    'Добавлено окно настроек (Ctrl+,) с выбором языка интерфейса; тема сменяется плавно.',
    'Добавлено окно справки (F1) со всеми сочетаниями клавиш.',
    'Нажатие на путь файла в строке состояния копирует полный путь; в меню «Файл» добавлено «Закрыть окно» (Ctrl+W).',
    'Добавлена версия для Linux (.deb и AppImage).',
    'Исправления: конвертация списков, флажки задач, мелкие правки интерфейса.',
  ],
  en: [
    'Reading, Visual, Code and Split modes in one switcher; Ctrl+/ flips Reading and editing.',
    'The outline moved to the right; its toggle sits in the top-right corner.',
    'Added find & replace (Ctrl+F / Ctrl+H).',
    'Added printing and saving as PDF.',
    'A new start screen.',
    'Added zooming (Ctrl+wheel, Ctrl+= / Ctrl+−).',
    'Added rendering of the kbd, sub, sup and br HTML tags; block-level HTML shows as code.',
    'Added a Settings window (Ctrl+,) with the interface language; themes now cross-fade.',
    'Added a Help window (F1) with every shortcut.',
    'Pressing the file path in the status bar copies the full path; "Close Window" (Ctrl+W) added to the File menu.',
    'Added a Linux version (.deb and AppImage).',
    'Fixes: list conversion, task checkboxes, minor interface polish.',
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
