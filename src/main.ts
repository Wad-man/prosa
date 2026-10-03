import {
  ask,
  message,
  open as openFileDialog,
  save as saveFileDialog,
} from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { VisualEditor } from './editor/visual';
import { SourceEditor } from './editor/source';
import { applyWebView2DragFix } from './platform/webview2-dnd';
import { getLang, setLang, t } from './i18n';
import './styles.css';

// Must run before the editors mount: it re-routes DataTransfer writes so
// HTML5 drag-and-drop survives inside the WebView2 shell (see module comment).
applyWebView2DragFix();

type Mode = 'visual' | 'source';

const MD_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }];
const MD_PATH_RE = /\.(md|markdown|mdown|mkd|txt)$/i;
const THEME_KEY = 'prosa.theme';

// In a plain browser (no Tauri shell) native APIs are unavailable;
// the editor core still works — only window/file integration is skipped.
const inTauri = '__TAURI_INTERNALS__' in window;
const nativeWindow = (): ReturnType<typeof getCurrentWindow> | null =>
  inTauri ? getCurrentWindow() : null;
const currentWindow = nativeWindow();

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
  aboutOverlay: $('about-overlay'),
  aboutModal: document.querySelector('#about-overlay .modal') as HTMLElement,
  aboutClose: $('about-close') as HTMLButtonElement,
  aboutVersion: $('about-version'),
  aboutDesc: $('about-desc'),
  aboutLicense: $('about-license') as HTMLAnchorElement,
  aboutCheck: $('about-check') as HTMLButtonElement,
  aboutLinks: Array.from(document.querySelectorAll<HTMLAnchorElement>('#about-overlay a')),
  closeOverlay: $('close-overlay'),
  ccText: $('cc-text'),
  ccDontSave: $('cc-dont-save') as HTMLButtonElement,
  ccCancel: $('cc-cancel') as HTMLButtonElement,
  ccSave: $('cc-save') as HTMLButtonElement,
};

const visual = new VisualEditor();
let source: SourceEditor | null = null; // lazily created on first switch

// Belt-and-suspenders alongside the editor change events: only real user input
// (pointer/keyboard) can mark the doc dirty. Programmatic or async updates —
// e.g. text dropped into the page without a click — still refresh the word
// count and the empty-state hint, they just never set the dirty flag.
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
  const title = `${prefix}${fileName()} — ProsaMD`;
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
    reportDocState();
  } else {
    scheduleStats();
  }
}

// Keep the Rust side in sync with this window's document state — it routes
// newly opened files (focus / reuse / new window) and warns before an update
// force-closes other windows.
function reportDocState(): void {
  if (!inTauri) return;
  void invoke('report_doc_state', {
    path: filePath,
    dirty,
    empty: getMarkdown().trim() === '',
  }).catch(() => {});
}

// An untouched untitled document — a newly opened file can take its place
// instead of spawning a window.
function pristine(): boolean {
  return filePath === null && !dirty && getMarkdown().trim() === '';
}

// Open a file in this window while it is still pristine; otherwise hand it
// to the Rust side, which focuses an existing window for the file or opens
// a new document window.
async function openPathBestWindow(path: string): Promise<void> {
  if (!inTauri || pristine()) {
    await loadPath(path);
    return;
  }
  await invoke('open_document_window', { path }).catch(async () => {
    // window creation failed — fall back to replacing this document
    if (await confirmLoseChanges()) await loadPath(path);
  });
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
    reportDocState();
  }, 0);
}

async function loadPath(path: string): Promise<boolean> {
  try {
    applyLoaded(await readTextFile(path), path);
    return true;
  } catch (err) {
    void message(`${t('openError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
    return false;
  }
}

// OS files dragged onto the window arrive as ordinary HTML5 drops: Tauri's
// native drag-drop handler is disabled so that in-page drag-and-drop (block
// handles, text) works in WebView2 — see dragDropEnabled in tauri.conf.json.
async function openDroppedFile(dt: DataTransfer, file: File): Promise<void> {
  if (!MD_PATH_RE.test(file.name)) {
    void message(t('notMarkdown'), { title: 'ProsaMD', kind: 'info' });
    return;
  }
  // A file dragged from Explorer may carry its file:/// URL — recover the
  // real path so saving works in place
  const uri = dt.getData('text/uri-list').trim().split('\n')[0] ?? '';
  if (inTauri && uri.startsWith('file:')) {
    try {
      const path = decodeURIComponent(new URL(uri).pathname).replace(/^\//, '');
      await openPathBestWindow(path);
      return;
    } catch {
      // no usable URL — fall back to the dragged file's contents
    }
  }
  // contents only: cannot be handed to another window — load here
  if (!(await confirmLoseChanges())) return;
  try {
    applyLoaded(await file.text(), null, file.name);
  } catch (err) {
    void message(`${t('openError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
  }
}

async function openFile(): Promise<void> {
  if (!inTauri) return;
  const picked = await openFileDialog({ multiple: false, directory: false, filters: MD_FILTER });
  if (typeof picked === 'string') await openPathBestWindow(picked);
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
    reportDocState();
  } catch (err) {
    void message(`${t('saveError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
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
  els.aboutCheck.disabled = true;
  try {
    let update: Awaited<ReturnType<typeof check>> = null;
    try {
      update = await check();
    } catch (err) {
      if (manual) {
        void message(`${t('updateCheckError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
      }
      return;
    }
    if (update === null) {
      if (manual) void message(t('upToDate'), { title: 'ProsaMD', kind: 'info' });
      return;
    }
    const confirmed = await ask(t('updateAvailable').replace('{version}', update.version), {
      title: t('updateTitle'),
      kind: 'info',
    });
    if (!confirmed) return;
    // the installer force-closes every window — other unsaved documents die with them
    try {
      if (await invoke<boolean>('has_dirty_windows')) {
        const proceed = await ask(t('updateOtherDirty'), { title: t('updateTitle'), kind: 'warning' });
        if (!proceed) return;
      }
    } catch {
      // command unavailable — skip the cross-window check
    }
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
      void message(`${t('updateError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
    }
  } finally {
    updateBusy = false;
    els.aboutCheck.disabled = false;
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

// ---------- modals ----------

let modalReturnFocus: HTMLElement | null = null;

function activeModalOverlay(): HTMLElement | null {
  if (!els.aboutOverlay.hidden) return els.aboutOverlay;
  if (!els.closeOverlay.hidden) return els.closeOverlay;
  return null;
}

function showModal(overlay: HTMLElement, initialFocus: HTMLElement): void {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.hidden = false;
  initialFocus.focus();
}

function hideModal(overlay: HTMLElement): void {
  overlay.hidden = true;
  const back = modalReturnFocus;
  modalReturnFocus = null;
  back?.focus();
}

// keep Tab cycling inside the open dialog
function trapTabKey(overlay: HTMLElement, e: KeyboardEvent): void {
  const focusable = Array.from(
    overlay.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
  ).filter((el) => el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function refreshAboutVersion(): void {
  els.aboutVersion.textContent = appVersion ? `${t('versionWord')} ${appVersion}` : '';
}

function openAbout(): void {
  refreshAboutVersion();
  showModal(els.aboutOverlay, els.aboutClose);
}

// ---------- window close guard ----------

let forceClose = false;

function closeWindow(): void {
  forceClose = true;
  void currentWindow?.close().catch(() => {});
}

function askBeforeClose(): void {
  els.ccText.textContent = t('closeQuestion').replace('{name}', fileName());
  showModal(els.closeOverlay, els.ccSave);
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

  els.aboutModal.setAttribute('aria-label', t('versionTip'));
  els.aboutDesc.textContent = t('aboutDesc');
  els.aboutLicense.textContent = t('licenseLink');
  els.aboutCheck.textContent = t('checkUpdates');
  els.aboutClose.setAttribute('aria-label', t('closeTip'));
  tip(els.aboutClose, t('closeTip'));
  els.ccDontSave.textContent = t('dontSave');
  els.ccCancel.textContent = t('cancel');
  els.ccSave.textContent = t('save');
  refreshAboutVersion();
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
    if (userInteracted) {
      markDirty();
      return;
    }
    // update without real user input behind it: not dirty, but the stats
    // and the empty-state hint must still track the actual content
    scheduleStats();
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
    if (!mod) {
      const overlay = activeModalOverlay();
      if (overlay === null) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        hideModal(overlay);
      } else if (e.key === 'Tab') {
        trapTabKey(overlay, e);
      }
      return;
    }
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
  reportDocState();

  // About dialog: the version in the statusbar opens it; the update check
  // that used to live there moved into the dialog
  els.stVersion.addEventListener('click', () => openAbout());
  els.aboutClose.addEventListener('click', () => hideModal(els.aboutOverlay));
  els.aboutCheck.addEventListener('click', () => {
    hideModal(els.aboutOverlay);
    void checkForUpdates(true);
  });
  els.aboutOverlay.addEventListener('click', (e) => {
    if (e.target === els.aboutOverlay) hideModal(els.aboutOverlay);
  });
  for (const link of els.aboutLinks) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (inTauri) {
        void openUrl(link.href).catch((err) => {
          void message(String(err), { title: 'ProsaMD', kind: 'error' });
        });
      } else {
        window.open(link.href, '_blank', 'noreferrer');
      }
    });
  }

  // close confirmation
  els.ccCancel.addEventListener('click', () => hideModal(els.closeOverlay));
  els.closeOverlay.addEventListener('click', (e) => {
    if (e.target === els.closeOverlay) hideModal(els.closeOverlay);
  });
  els.ccDontSave.addEventListener('click', () => {
    hideModal(els.closeOverlay);
    closeWindow();
  });
  els.ccSave.addEventListener('click', () => {
    hideModal(els.closeOverlay);
    void (async () => {
      await saveFile(filePath === null);
      if (!dirty) closeWindow();
    })();
  });
  void currentWindow?.onCloseRequested(async (event) => {
    if (!dirty || forceClose) return;
    event.preventDefault();
    askBeforeClose();
  });

  if (inTauri) {
    // document windows created by the Rust side carry their file in the URL
    const qsFile = new URLSearchParams(location.search).get('file');
    let opened = false;
    if (qsFile !== null && MD_PATH_RE.test(qsFile)) opened = await loadPath(qsFile);
    // cold start on the main window: the OS passed the associated file as a
    // CLI argument
    if (!opened && currentWindow?.label === 'main') {
      try {
        const initial = await invoke<string | null>('get_initial_file');
        if (initial !== null && MD_PATH_RE.test(initial)) await loadPath(initial);
      } catch {
        // command unavailable — nothing to open
      }
    }

    // version shown in the statusbar opens the About dialog
    void getVersion()
      .then((v) => {
        appVersion = v;
        els.stVersion.textContent = `v${v}`;
        els.stVersion.hidden = false;
        refreshAboutVersion();
      })
      .catch(() => {});
    // background update check shortly after launch; only the main window runs
    // it so multiple documents don't race to install the same update
    if (currentWindow?.label === 'main') {
      window.setTimeout(() => void checkForUpdates(false), 3000);
    }
  }
}

// The Rust side routes a file opened outside any window here when this window
// is still pristine; otherwise it opens a new document window itself.
function prosaOpen(path: string): void {
  if (!MD_PATH_RE.test(path)) return;
  if (pristine()) void loadPath(path);
  else void invoke('open_document_window', { path }).catch(() => {});
}
(window as unknown as { __prosaOpen?: (path: string) => void }).__prosaOpen = prosaOpen;

void init();
