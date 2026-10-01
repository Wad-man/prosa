import {
  ask,
  message,
  open as openFileDialog,
  save as saveFileDialog,
} from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { VisualEditor } from './editor/visual';
import { SourceEditor } from './editor/source';
import { getLang, setLang, t } from './i18n';
import './styles.css';

type Mode = 'visual' | 'source';

const MD_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }];
const MD_PATH_RE = /\.(md|markdown|mdown|mkd|txt)$/i;
const THEME_KEY = 'prosa.theme';

// In a plain browser (no Tauri shell) native APIs are unavailable;
// the editor core still works — only window/file integration is skipped.
const inTauri = '__TAURI_INTERNALS__' in window;
const nativeWindow = (): ReturnType<typeof getCurrentWindow> | null =>
  inTauri ? getCurrentWindow() : null;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};

const els = {
  app: $('app'),
  btnOpen: $('btn-open') as HTMLButtonElement,
  btnSave: $('btn-save') as HTMLButtonElement,
  btnSaveAs: $('btn-save-as') as HTMLButtonElement,
  btnLang: $('btn-lang') as HTMLButtonElement,
  btnTheme: $('btn-theme') as HTMLButtonElement,
  btnVisual: $('btn-mode-visual') as HTMLButtonElement,
  btnSource: $('btn-mode-source') as HTMLButtonElement,
  modeSwitch: $('mode-switch'),
  lblOpen: $('lbl-open'),
  lblSave: $('lbl-save'),
  lblSaveAs: $('lbl-saveas'),
  lblLang: $('lbl-lang'),
  visualPane: $('visual-editor'),
  sourcePane: $('source-editor'),
  ehLine: $('eh-line'),
  ehOpen: $('eh-open'),
  ehMode: $('eh-mode'),
  stPath: $('st-path'),
  stModified: $('st-modified'),
  stCount: $('st-count'),
  stVersion: $('st-version') as HTMLButtonElement,
};

const visual = new VisualEditor();
let source: SourceEditor | null = null; // lazily created on first switch

// Crepe mounts focus/cursor widgets asynchronously, which the mutation
// observer would misread as edits; only user input can mark the doc dirty.
let userInteracted = false;

let mode: Mode = 'visual';
let filePath: string | null = null;
// name of a file whose contents were loaded without a path (OS drag-drop
// without a usable file URL) — used for the title and the Save As default
let fileSuggestion: string | null = null;
let dirty = false;
let suppressChange = false;
let statsTimer: number | undefined;

function getMarkdown(): string {
  if (mode === 'visual') return visual.getMarkdown();
  return source?.getContent() ?? '';
}

function fileName(): string {
  if (filePath !== null) return filePath.split(/[\\/]/).pop() ?? t('untitled');
  return fileSuggestion ?? t('untitled');
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function statsText(words: number, chars: number): string {
  const ru = getLang() === 'ru';
  const fmt = (n: number): string => n.toLocaleString(ru ? 'ru-RU' : 'en-US');
  const wordsLabel = ru ? pluralRu(words, 'слово', 'слова', 'слов') : t('words');
  const parts = [`${fmt(words)} ${wordsLabel}`, `${fmt(chars)} ${t('chars')}`];
  if (words > 0) parts.push(`${Math.ceil(words / 200)} ${t('minShort')}`);
  return parts.join(' · ');
}

function refreshEmptyState(): void {
  els.app.classList.toggle('empty', getMarkdown().trim() === '');
}

function refreshChrome(): void {
  const prefix = dirty ? '• ' : '';
  const title = `${prefix}${fileName()} — Prosa`;
  document.title = title;
  const nw = nativeWindow();
  if (nw) void nw.setTitle(title).catch(() => {});
  els.stPath.textContent = filePath ?? fileSuggestion ?? t('untitled');
  els.stPath.title = filePath ?? '';
  els.stModified.hidden = !dirty;
  els.btnSave.disabled = !dirty && filePath !== null;
  updateStats();
  refreshEmptyState();
}

let statsPending = '';
function scheduleStats(): void {
  statsPending = getMarkdown();
  window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    const md = statsPending.trim();
    const words = md ? md.split(/\s+/).length : 0;
    els.stCount.textContent = statsText(words, statsPending.length);
    refreshEmptyState();
  }, 250);
}

function updateStats(): void {
  window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => scheduleStats(), 0);
}

function markDirty(): void {
  if (suppressChange) return;
  if (!dirty) {
    dirty = true;
    refreshChrome();
  } else {
    scheduleStats();
  }
}

async function confirmLoseChanges(): Promise<boolean> {
  if (!dirty) return true;
  return await ask(t('discardQuestion'), { title: t('discardTitle'), kind: 'warning' });
}

function applyLoaded(text: string, path: string | null, suggestedName?: string): void {
  suppressChange = true;
  if (mode === 'visual') visual.setMarkdown(text);
  else source?.setContent(text);
  filePath = path;
  fileSuggestion = path === null ? (suggestedName ?? null) : null;
  dirty = false;
  // let programmatic editor updates land before unmasking change events
  window.setTimeout(() => {
    suppressChange = false;
    refreshChrome();
  }, 0);
}

async function loadPath(path: string): Promise<boolean> {
  try {
    applyLoaded(await readTextFile(path), path);
    return true;
  } catch (err) {
    void message(`${t('openError')}: ${String(err)}`, { title: 'Prosa', kind: 'error' });
    return false;
  }
}

// OS files dragged onto the window arrive as ordinary HTML5 drops: Tauri's
// native drag-drop handler is disabled so that in-page drag-and-drop (block
// handles, text) works in WebView2 — see dragDropEnabled in tauri.conf.json.
async function openDroppedFile(dt: DataTransfer, file: File): Promise<void> {
  if (!MD_PATH_RE.test(file.name)) {
    void message(t('notMarkdown'), { title: 'Prosa', kind: 'info' });
    return;
  }
  if (!(await confirmLoseChanges())) return;
  // A file dragged from Explorer may carry its file:/// URL — recover the
  // real path so saving works in place
  const uri = dt.getData('text/uri-list').trim().split('\n')[0] ?? '';
  if (inTauri && uri.startsWith('file:')) {
    try {
      const path = decodeURIComponent(new URL(uri).pathname).replace(/^\//, '');
      if (await loadPath(path)) return;
    } catch {
      // no usable URL — fall back to the dragged file's contents
    }
  }
  try {
    applyLoaded(await file.text(), null, file.name);
  } catch (err) {
    void message(`${t('openError')}: ${String(err)}`, { title: 'Prosa', kind: 'error' });
  }
}

async function openFile(): Promise<void> {
  if (!inTauri) return;
  if (!(await confirmLoseChanges())) return;
  const picked = await openFileDialog({ multiple: false, directory: false, filters: MD_FILTER });
  if (typeof picked === 'string') await loadPath(picked);
}

async function saveFile(saveAs: boolean): Promise<void> {
  if (!inTauri) return;
  const md = getMarkdown();
  let path = filePath;
  if (path === null || saveAs) {
    const defaultName = filePath === null ? (fileSuggestion ?? `${t('untitled')}.md`) : fileName();
    const picked = await saveFileDialog({ defaultPath: defaultName, filters: MD_FILTER });
    if (typeof picked !== 'string') return;
    path = picked;
  }
  try {
    await writeTextFile(path, md);
    filePath = path;
    dirty = false;
    refreshChrome();
  } catch (err) {
    void message(`${t('saveError')}: ${String(err)}`, { title: 'Prosa', kind: 'error' });
  }
}

// ---------- updates ----------

let updateBusy = false;
let appVersion = '';

// The Windows installer force-closes the app, so anything unsaved is lost;
// save first — silently when the doc has a path, via a dialog when untitled.
async function saveBeforeUpdate(): Promise<boolean> {
  if (!dirty) return true;
  if (filePath !== null) {
    await saveFile(false);
  } else {
    const save = await ask(t('updateSaveFirst'), { title: t('updateTitle'), kind: 'warning' });
    if (!save) return true; // user chose to discard explicitly
    await saveFile(true);
  }
  return !dirty; // a failed or cancelled save aborts the update
}

async function checkForUpdates(manual: boolean): Promise<void> {
  if (!inTauri || updateBusy) return;
  updateBusy = true;
  try {
    let update: Awaited<ReturnType<typeof check>> = null;
    try {
      update = await check();
    } catch (err) {
      if (manual) {
        void message(`${t('updateCheckError')}: ${String(err)}`, { title: 'Prosa', kind: 'error' });
      }
      return;
    }
    if (update === null) {
      if (manual) void message(t('upToDate'), { title: 'Prosa', kind: 'info' });
      return;
    }
    const confirmed = await ask(t('updateAvailable').replace('{version}', update.version), {
      title: t('updateTitle'),
      kind: 'info',
    });
    if (!confirmed) return;
    if (!(await saveBeforeUpdate())) return;

    let received = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          els.stVersion.textContent = t('updateDownloading');
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          const percent = total > 0 ? ` ${Math.floor((received / total) * 100)}%` : '';
          els.stVersion.textContent = `${t('updateDownloading')}${percent}`;
        } else {
          els.stVersion.textContent = t('updateInstalling');
        }
      });
      // on Windows the installer exits the app during install, so this
      // only runs on platforms where the process survives
      await relaunch();
    } catch (err) {
      void message(`${t('updateError')}: ${String(err)}`, { title: 'Prosa', kind: 'error' });
    }
  } finally {
    updateBusy = false;
    if (appVersion) els.stVersion.textContent = `v${appVersion}`;
  }
}

function setMode(next: Mode): void {
  if (next === mode && source !== null) {
    // still normalize UI classes on early calls
  } else if (next !== mode) {
    const md = getMarkdown();
    suppressChange = true;
    if (next === 'source') {
      if (source === null) source = new SourceEditor(els.sourcePane, md, markDirty);
      else source.setContent(md);
    } else {
      visual.setMarkdown(md);
    }
    mode = next;
    window.setTimeout(() => {
      suppressChange = false;
    }, 0);
  }
  els.visualPane.classList.toggle('active', mode === 'visual');
  els.sourcePane.classList.toggle('active', mode === 'source');
  els.btnVisual.classList.toggle('active', mode === 'visual');
  els.btnSource.classList.toggle('active', mode === 'source');
  els.btnVisual.setAttribute('aria-selected', String(mode === 'visual'));
  els.btnSource.setAttribute('aria-selected', String(mode === 'source'));
  els.modeSwitch.dataset.active = mode;
  els.app.dataset.mode = mode;
  (mode === 'visual' ? visual.focus() : source?.focus());
  refreshChrome();
}

function toggleMode(): void {
  setMode(mode === 'visual' ? 'source' : 'visual');
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function applyStaticTexts(): void {
  document.documentElement.lang = getLang();
  document.getElementById('toolbar')?.setAttribute('aria-label', t('toolbar'));
  els.modeSwitch.setAttribute('aria-label', t('modeToggle'));
  els.lblOpen.textContent = t('open');
  els.lblSave.textContent = t('save');
  els.lblSaveAs.textContent = t('saveAs');
  els.lblLang.textContent = getLang().toUpperCase();
  els.ehLine.textContent = t('emptyDrop');
  els.ehOpen.textContent = t('open').replace('…', '');
  els.ehMode.textContent = t('modeToggle');

  const tip = (el: HTMLElement, text: string): void => el.setAttribute('data-tip', text);
  tip(els.btnOpen, `${t('open')} · Ctrl+O`);
  tip(els.btnSave, `${t('save')} · Ctrl+S`);
  tip(els.btnSaveAs, `${t('saveAs')} · Ctrl+Shift+S`);
  tip(els.btnVisual, `${t('visual')} · Ctrl+/`);
  tip(els.btnSource, `${t('source')} · Ctrl+/`);
  els.btnVisual.setAttribute('aria-label', t('visual'));
  els.btnSource.setAttribute('aria-label', t('source'));
  tip(els.btnTheme, t('themeTip'));
  els.btnTheme.setAttribute('aria-label', t('themeTip'));
  tip(els.btnLang, t('langTip'));
  els.btnLang.setAttribute('aria-label', t('langTip'));

  els.stPath.textContent = filePath ?? t('untitled');
  els.stVersion.title = t('versionTip');
  els.stVersion.setAttribute('aria-label', t('versionTip'));
}

async function init(): Promise<void> {
  window.addEventListener(
    'pointerdown',
    () => {
      userInteracted = true;
    },
    true,
  );
  window.addEventListener(
    'keydown',
    () => {
      userInteracted = true;
    },
    true,
  );

  applyStaticTexts();
  await visual.create(els.visualPane, '', () => {
    if (userInteracted) markDirty();
  });
  setMode('visual');

  els.btnOpen.addEventListener('click', () => void openFile());
  els.btnSave.addEventListener('click', () => void saveFile(false));
  els.btnSaveAs.addEventListener('click', () => void saveFile(true));
  els.btnVisual.addEventListener('click', () => setMode('visual'));
  els.btnSource.addEventListener('click', () => setMode('source'));
  els.btnLang.addEventListener('click', () => {
    setLang(getLang() === 'ru' ? 'en' : 'ru');
    applyStaticTexts();
    refreshChrome();
  });
  els.btnTheme.addEventListener('click', () => {
    const now = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(now);
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      void saveFile(e.shiftKey);
    } else if (key === 'o') {
      e.preventDefault();
      void openFile();
    } else if (key === '/') {
      e.preventDefault();
      toggleMode();
    }
  });

  // files dragged from the OS: plain HTML5 drop (Tauri's native drag-drop
  // handler is off — see openDroppedFile)
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const file = dt?.files[0];
    if (!dt || !file) return;
    e.preventDefault();
    void openDroppedFile(dt, file);
  });

  refreshChrome();

  if (inTauri) {
    // cold start: the OS passed the associated file as a CLI argument
    try {
      const initial = await invoke<string | null>('get_initial_file');
      if (initial !== null && MD_PATH_RE.test(initial)) await loadPath(initial);
    } catch {
      // command unavailable — nothing to open
    }
    // warm start: a second instance forwarded its file argument to us
    void listen<string>('prosa://open-file', (event) => {
      const path = event.payload;
      if (!MD_PATH_RE.test(path)) return;
      void (async () => {
        if (await confirmLoseChanges()) await loadPath(path);
      })();
    }).catch(() => {});

    // version shown in the statusbar doubles as the manual update check
    void getVersion()
      .then((v) => {
        appVersion = v;
        els.stVersion.textContent = `v${v}`;
        els.stVersion.hidden = false;
      })
      .catch(() => {});
    els.stVersion.addEventListener('click', () => void checkForUpdates(true));
    // background update check shortly after launch; silent unless an update exists
    window.setTimeout(() => void checkForUpdates(false), 3000);
  }
}

void init();
