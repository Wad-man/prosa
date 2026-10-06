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
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { VisualEditor } from './editor/visual';
import { SourceEditor } from './editor/source';
import { editorStrings } from './editor/crepe-locale';
import {
  sourceSetBlock,
  sourceToggleMark,
  sourceUndoRedo,
  sourceSelectAll,
  sourceSelectionText,
  sourceDeleteSelection,
  sourceInsertText,
  sourceCurrentBlock,
  sourceDeleteLines,
  sourceToggleTask,
  sourceClearFormatting,
} from './editor/md-source';
import type { BlockId, MarkId } from './editor/actions';
import { splitFrontMatter } from './frontmatter';
import { MenuBar, type MenuSection } from './menu';
import { TocPanel } from './toc';
import { isFeatureEnabled, setFeatureEnabled, onFeaturesChanged } from './features';
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
  menubar: $('menubar'),
  btnLang: $('btn-lang') as HTMLButtonElement,
  btnTheme: $('btn-theme') as HTMLButtonElement,
  btnVisual: $('btn-mode-visual') as HTMLButtonElement,
  btnSource: $('btn-mode-source') as HTMLButtonElement,
  modeSwitch: $('mode-switch'),
  lblLang: $('lbl-lang'),
  editorHost: $('editor-host'),
  visualPane: $('visual-editor'),
  sourcePane: $('source-editor'),
  ehLine: $('eh-line'),
  ehOpen: $('eh-open'),
  ehMode: $('eh-mode'),
  ehFormatKbd: $('eh-format-kbd'),
  ehFormat: $('eh-format'),
  stPath: $('st-path'),
  stModified: $('st-modified'),
  stCount: $('st-count'),
  stVersion: $('st-version') as HTMLButtonElement,
  stToc: $('st-toc') as HTMLButtonElement,
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
  hotkeysOverlay: $('hotkeys-overlay'),
  hotkeysModal: document.querySelector('#hotkeys-overlay .modal') as HTMLElement,
  hotkeysClose: $('hotkeys-close') as HTMLButtonElement,
  hotkeysTitle: $('hotkeys-title'),
  hotkeysBody: $('hotkeys-body'),
};

const visual = new VisualEditor();
let source: SourceEditor | null = null; // lazily created on first switch
const menuBar = new MenuBar();
const toc = new TocPanel();

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

// ---------- lossless round-trip bookkeeping (#33, #29) ----------
// The visual mode reserializes markdown (table padding etc.), so byte
// fidelity needs more than getMarkdown():
// - frontMatter: the raw YAML block carved out of the visual editor's body
//   (which would otherwise chew it into hr + headings);
// - savedRaw: the exact bytes of the last load/save — an unedited document
//   writes them back verbatim instead of a reserialization;
// - baseline: the editors' current serialized form right after load/save;
//   content returning to it means "not dirty" (a full Ctrl+Z undoes the
//   dirty flag too) and restores the raw-bytes passthrough on save;
// - editedSinceSave: any real user edit since load/save — keeps the
//   passthrough honest across mode switches (a switched-but-unedited doc
//   still saves its original bytes).
let frontMatter: string | null = null;
let savedRaw = '';
let baseline = '';
let editedSinceSave = false;
let dirtyCheckTimer: number | undefined;

/** The document as a file: front-matter + the active editor's content. In
 * the source mode that is the raw text itself; in the visual mode the body
 * is Crepe's serialization with the front-matter block re-attached. */
function currentFullText(): string {
  if (mode === 'source') return source?.getContent() ?? '';
  return (frontMatter ?? '') + visual.getMarkdown();
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
  const wordsLabel = ru ? pluralRu(words, 'слово', 'слова', 'слов') : words === 1 ? t('word') : t('words');
  const parts = [`${fmt(words)} ${wordsLabel}`, `${fmt(chars)} ${t('chars')}`];
  if (words > 0) parts.push(`${Math.ceil(words / 200)} ${t('minShort')}`);
  return parts.join(' · ');
}

function refreshEmptyState(): void {
  els.app.classList.toggle('empty', currentFullText().trim() === '');
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
  updateStats();
  refreshEmptyState();
}

let statsPending = '';
function scheduleStats(): void {
  statsPending = currentFullText();
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
  editedSinceSave = true;
  if (!dirty) {
    dirty = true;
    refreshChrome();
    reportDocState();
  } else {
    scheduleStats();
  }
  scheduleDirtyCheck();
}

// #29: a full undo back to the last saved state is not a change — once
// edits settle, content equal to the baseline clears the dirty flag (and
// the title dot) and re-arms the raw-bytes passthrough for the next save.
function scheduleDirtyCheck(): void {
  window.clearTimeout(dirtyCheckTimer);
  dirtyCheckTimer = window.setTimeout(() => {
    if (!dirty || suppressChange) return;
    if (currentFullText() === baseline) {
      dirty = false;
      editedSinceSave = false;
      refreshChrome();
      reportDocState();
    }
  }, 350);
}

// Keep the Rust side in sync with this window's document state — it routes
// newly opened files (focus / reuse / new window) and warns before an update
// force-closes other windows.
function reportDocState(): void {
  if (!inTauri) return;
  void invoke('report_doc_state', {
    path: filePath,
    dirty,
    empty: currentFullText().trim() === '',
  }).catch(() => {});
}

// An untouched untitled document — a newly opened file can take its place
// instead of spawning a window.
function pristine(): boolean {
  return filePath === null && !dirty && currentFullText().trim() === '';
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
  savedRaw = text;
  // the visual editor must not see the front-matter block (#33); the raw
  // source view keeps it as part of the file text
  const { frontMatter: fm, body } = splitFrontMatter(text);
  frontMatter = fm;
  if (mode === 'visual') visual.setMarkdown(body);
  else source?.setContent(text);
  filePath = path;
  fileSuggestion = path === null ? (suggestedName ?? null) : null;
  dirty = false;
  editedSinceSave = false;
  window.clearTimeout(dirtyCheckTimer);
  // let programmatic editor updates land before unmasking change events
  window.setTimeout(() => {
    suppressChange = false;
    baseline = currentFullText();
    refreshChrome();
    reportDocState();
    toc.refresh();
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
  const current = currentFullText();
  // #33: a document whose content never left the last loaded/saved state
  // writes the original bytes back — no visual-mode reserialization, so
  // table padding and front-matter fences survive byte-for-byte
  const md = !editedSinceSave || current === baseline ? savedRaw : current;
  let path = filePath;
  if (path === null || saveAs) {
    const defaultName = filePath === null ? (fileSuggestion ?? `${t('untitled')}.md`) : fileName();
    const picked = await saveFileDialog({ defaultPath: defaultName, filters: MD_FILTER });
    if (typeof picked !== 'string') return;
    path = picked;
  }
  try {
    await writeTextFile(path, md);
    savedRaw = md;
    baseline = current;
    filePath = path;
    dirty = false;
    editedSinceSave = false;
    window.clearTimeout(dirtyCheckTimer);
    refreshChrome();
    reportDocState();
  } catch (err) {
    void message(`${t('saveError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
  }
}

// ---------- new document (Файл → Создать, Ctrl+N) ----------

// Mirrors the in-app Открыть semantics: the new document replaces this
// window's content after an unsaved-changes guard. Spawning windows is
// multi-window territory (plugin #11), not this command's business.
async function newFile(): Promise<void> {
  if (!(await confirmLoseChanges())) return;
  applyLoaded('', null);
}

// ---------- clipboard (Правка) ----------

// Native clipboard through the Tauri plugin — WebView2 blocks
// navigator.clipboard/execCommand paste behind a permission the shell never
// grants (same WebView2 trap class as the drag-and-drop fix). The browser
// fallback keeps `npm run dev` usable.
async function readClipboard(): Promise<string | null> {
  try {
    return inTauri ? await readClipboardText() : await navigator.clipboard.readText();
  } catch {
    if (inTauri) void message(t('clipboardError'), { title: 'ProsaMD', kind: 'error' });
    return null;
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (inTauri) await writeClipboardText(text);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (inTauri) void message(t('clipboardError'), { title: 'ProsaMD', kind: 'error' });
    return false;
  }
}

// ---------- mode-aware command dispatch for the menu bar ----------

function editUndoRedo(which: 'undo' | 'redo'): void {
  if (mode === 'visual') visual.undoRedo(which);
  else if (source) sourceUndoRedo(source.view, which);
}

function editSelectAll(): void {
  if (mode === 'visual') visual.selectAll();
  else if (source) sourceSelectAll(source.view);
}

function selectionText(): string {
  if (mode === 'visual') return visual.selectionText();
  return source ? sourceSelectionText(source.view) : '';
}

async function editCopy(): Promise<void> {
  await writeClipboard(selectionText());
}

async function editCut(): Promise<void> {
  if (await writeClipboard(selectionText())) {
    if (mode === 'visual') visual.deleteSelection();
    else if (source) sourceDeleteSelection(source.view);
  }
}

// Markdown-aware in visual mode (pasted markdown renders), plain in source
async function editPaste(): Promise<void> {
  const text = await readClipboard();
  if (text === null || text === '') return;
  if (mode === 'visual') visual.insertMarkdown(text);
  else if (source) sourceInsertText(source.view, text);
}

function editBlock(id: BlockId): void {
  if (mode === 'visual') visual.applyBlock(id);
  else if (source) sourceSetBlock(source.view, id);
}

function editMark(id: MarkId): void {
  if (mode === 'visual') visual.toggleMark(id);
  else if (source) sourceToggleMark(source.view, id);
}

// ---------- line-level commands (#35 aliases: Obsidian / Word / Telegram) ----------

function editDeleteLine(): void {
  if (mode === 'visual') visual.deleteBlock();
  else if (source) sourceDeleteLines(source.view);
}

function editToggleTask(): void {
  if (mode === 'visual') visual.toggleTask();
  else if (source) sourceToggleTask(source.view);
}

function editClearFormatting(): void {
  if (mode === 'visual') visual.clearFormatting();
  else if (source) sourceClearFormatting(source.view);
}

function currentBlock(): BlockId | null {
  if (mode === 'visual') return visual.currentBlock();
  return source ? sourceCurrentBlock(source.view) : null;
}

function openExternal(url: string): void {
  if (inTauri) {
    void openUrl(url).catch((err) => {
      void message(String(err), { title: 'ProsaMD', kind: 'error' });
    });
  } else {
    window.open(url, '_blank', 'noreferrer');
  }
}

// ---------- TOC feature (#21) ----------

function applyTocFeature(): void {
  toc.setVisible(isFeatureEnabled('toc'));
  toc.refresh();
  // the statusbar toggle reflects the same feature flag (setFeatureEnabled
  // above fires the cross-listener event that lands here)
  els.stToc.setAttribute('aria-pressed', String(isFeatureEnabled('toc')));
}

function toggleToc(): void {
  setFeatureEnabled('toc', !isFeatureEnabled('toc')); // listener applies it
}

let tocTimer: number | undefined;
function scheduleToc(): void {
  if (!toc.isVisible()) return;
  window.clearTimeout(tocTimer);
  tocTimer = window.setTimeout(() => toc.refresh(), 300);
}

let tocActiveQueued = false;
function queueTocActive(): void {
  if (tocActiveQueued || !toc.isVisible()) return;
  tocActiveQueued = true;
  requestAnimationFrame(() => {
    tocActiveQueued = false;
    toc.updateActive();
  });
}

// ---------- menu bar (#20) ----------

const sep = (): MenuSection['entries'][number] => ({ label: '', separator: true });

function buildMenuSections(): (() => MenuSection)[] {
  return [
    (): MenuSection => ({
      label: t('mFile'),
      altKey: 'KeyF',
      entries: [
        { label: t('newDoc'), hotkey: 'Ctrl+N', action: () => void newFile() },
        { label: t('open'), hotkey: 'Ctrl+O', action: () => void openFile() },
        sep(),
        { label: t('save'), hotkey: 'Ctrl+S', action: () => void saveFile(false) },
        { label: t('saveAs'), hotkey: 'Ctrl+Shift+S', action: () => void saveFile(true) },
      ],
    }),
    (): MenuSection => ({
      label: t('mEdit'),
      altKey: 'KeyE',
      entries: [
        { label: t('undo'), hotkey: 'Ctrl+Z', action: () => editUndoRedo('undo') },
        { label: t('redo'), hotkey: 'Ctrl+Y', action: () => editUndoRedo('redo') },
        sep(),
        { label: t('cut'), hotkey: 'Ctrl+X', action: () => void editCut() },
        { label: t('copy'), hotkey: 'Ctrl+C', action: () => void editCopy() },
        { label: t('paste'), hotkey: 'Ctrl+V', action: () => void editPaste() },
        sep(),
        { label: t('selectAll'), hotkey: 'Ctrl+A', action: () => editSelectAll() },
        { label: t('deleteLine'), hotkey: 'Ctrl+D', action: () => editDeleteLine() },
      ],
    }),
    (): MenuSection => {
      const s = editorStrings(getLang());
      // one scan per open (source mode walks the doc to the cursor) — the
      // checkmarks re-read on the next open, which is when they're visible
      const current = currentBlock();
      const block = (id: BlockId, label: string, hotkey?: string) => ({
        label,
        hotkey,
        action: () => editBlock(id),
        checked: () => current === id,
      });
      return {
        label: t('mParagraph'),
        altKey: 'KeyP',
        entries: [
          block('h1', s.h1, 'Ctrl+1'),
          block('h2', s.h2, 'Ctrl+2'),
          block('h3', s.h3, 'Ctrl+3'),
          block('h4', s.h4, 'Ctrl+4'),
          block('h5', s.h5, 'Ctrl+5'),
          block('h6', s.h6, 'Ctrl+6'),
          block('text', s.text, 'Ctrl+0'),
          sep(),
          block('quote', s.quote, 'Ctrl+Shift+B / Ctrl+Shift+Q'),
          block('ul', s.bulletList, 'Ctrl+Alt+8 / Ctrl+Shift+L'),
          block('ol', s.orderedList, 'Ctrl+Alt+7'),
          block('code', s.codeBlock, 'Ctrl+Alt+C'),
          sep(),
          {
            label: t('taskToggle'),
            hotkey: 'Ctrl+L',
            action: () => editToggleTask(),
          },
        ],
      };
    },
    (): MenuSection => {
      const s = editorStrings(getLang());
      const mark = (id: MarkId, label: string, hotkey?: string) => ({
        label,
        hotkey,
        action: () => editMark(id),
      });
      return {
        label: t('mFormat'),
        altKey: 'KeyO',
        entries: [
          mark('bold', s.bold, 'Ctrl+B'),
          mark('italic', s.italic, 'Ctrl+I'),
          mark('strike', s.strikethrough, 'Ctrl+Shift+X'),
          mark('code', s.inlineCode, 'Ctrl+E / Ctrl+Shift+M'),
          sep(),
          mark('link', s.link, 'Ctrl+K'),
          { label: t('clearFormat'), hotkey: 'Ctrl+Shift+N', action: () => editClearFormatting() },
        ],
      };
    },
    (): MenuSection => ({
      label: t('mView'),
      altKey: 'KeyV',
      entries: [
        {
          label: t('modeSource'),
          hotkey: 'Ctrl+/',
          action: () => toggleMode(),
          checked: () => mode === 'source',
        },
        sep(),
        {
          label: t('themeLight'),
          action: () => applyTheme('light'),
          checked: () => document.documentElement.dataset.theme !== 'dark',
        },
        {
          label: t('themeDark'),
          action: () => applyTheme('dark'),
          checked: () => document.documentElement.dataset.theme === 'dark',
        },
        sep(),
        {
          label: t('tocTitle'),
          hotkey: 'Ctrl+Shift+1',
          action: () => toggleToc(),
          checked: () => isFeatureEnabled('toc'),
        },
      ],
    }),
    (): MenuSection => ({
      label: t('mHelp'),
      altKey: 'KeyH',
      entries: [
        { label: t('versionTip'), action: () => openAbout() },
        { label: t('hotkeys'), action: () => openHotkeys() },
        { label: t('checkUpdates'), action: () => void checkForUpdates(true) },
        sep(),
        { label: t('website'), action: () => openExternal('https://prosamd.ru') },
        { label: t('sourceCode'), action: () => openExternal('https://github.com/Wad-man/prosa') },
      ],
    }),
  ];
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
    const md = currentFullText();
    suppressChange = true;
    if (next === 'source') {
      // the raw view shows the whole file — front-matter included
      if (source === null)
        source = new SourceEditor(els.sourcePane, md, () => {
          markDirty();
          scheduleToc();
        });
      else source.setContent(md);
    } else {
      // leaving the raw view: re-split, the front-matter may have been
      // edited (or removed) as plain text
      const { frontMatter: fm, body } = splitFrontMatter(md);
      frontMatter = fm;
      visual.setMarkdown(body);
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
  // heading sources differ per mode (live DOM vs text scan)
  toc.refresh();
}

function toggleMode(): void {
  setMode(mode === 'visual' ? 'source' : 'visual');
}

// ---------- modals ----------

let modalReturnFocus: HTMLElement | null = null;

function activeModalOverlay(): HTMLElement | null {
  if (!els.aboutOverlay.hidden) return els.aboutOverlay;
  if (!els.closeOverlay.hidden) return els.closeOverlay;
  if (!els.hotkeysOverlay.hidden) return els.hotkeysOverlay;
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

// the focusable set shared by Tab trapping and arrow-key navigation
function modalFocusables(overlay: HTMLElement): HTMLElement[] {
  return Array.from(
    overlay.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
  ).filter((el) => el.offsetParent !== null);
}

// keep Tab cycling inside the open dialog
function trapTabKey(overlay: HTMLElement, e: KeyboardEvent): void {
  const focusable = modalFocusables(overlay);
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

// native Windows dialogs move focus between buttons with arrow keys — mirror
// that; with a single focusable (the hotkeys dialog) arrows stay native
// (with focus on the dialog card they are a no-op — the scrollable list is a
// descendant, not an ancestor, so keyboard scrolling needs the wheel)
function moveModalFocus(overlay: HTMLElement, e: KeyboardEvent): void {
  const focusable = modalFocusables(overlay);
  if (focusable.length < 2) return;
  const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  const index = focusable.findIndex((el) => el === document.activeElement);
  const next =
    index === -1
      ? focusable[backward ? focusable.length - 1 : 0]
      : focusable[(index + (backward ? -1 : 1) + focusable.length) % focusable.length];
  e.preventDefault();
  next.focus();
}

function refreshAboutVersion(): void {
  els.aboutVersion.textContent = appVersion ? `${t('versionWord')} ${appVersion}` : '';
}

function openAbout(): void {
  refreshAboutVersion();
  // focus the dialog card, not the × button: a keyboard-opened dialog would
  // otherwise show the close button as hovered (focus-visible tooltip/outline)
  showModal(els.aboutOverlay, els.aboutModal);
}

// ---------- hotkeys dialog ----------

/**
 * Builds the shortcuts list from the live menu sections — the menu is the
 * single source of truth, so a new hotkey shows up here automatically.
 * Sections with no hotkey-carrying entries are skipped; the Alt-accelerators
 * (menu opening) are listed first as their own group.
 */
function buildHotkeysBody(): void {
  const body = els.hotkeysBody;
  body.replaceChildren();
  const sections = buildMenuSections().map((make) => make());

  const menu = document.createElement('section');
  menu.className = 'hk-group';
  const menuTitle = document.createElement('h3');
  menuTitle.textContent = t('menuBar');
  menu.append(menuTitle);
  for (const s of sections) {
    if (!s.altKey) continue;
    menu.append(hkRow(s.label, `Alt+${s.altKey.replace('Key', '')}`));
  }
  body.append(menu);

  for (const s of sections) {
    const group = document.createElement('section');
    group.className = 'hk-group';
    const title = document.createElement('h3');
    title.textContent = s.label;
    group.append(title);
    let rows = 0;
    for (const entry of s.entries) {
      if (entry.separator || !entry.hotkey) continue;
      group.append(hkRow(entry.label, entry.hotkey));
      rows++;
    }
    if (rows > 0) body.append(group);
  }
}

function hkRow(label: string, hotkey: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hk-row';
  const what = document.createElement('span');
  what.textContent = label;
  const keys = document.createElement('kbd');
  keys.className = 'hk-kbd';
  keys.textContent = hotkey;
  row.append(what, keys);
  return row;
}

function openHotkeys(): void {
  els.hotkeysTitle.textContent = t('hotkeys');
  buildHotkeysBody();
  showModal(els.hotkeysOverlay, els.hotkeysModal);
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
  els.menubar.setAttribute('aria-label', t('menuBar'));
  els.modeSwitch.setAttribute('aria-label', t('modeToggle'));
  els.lblLang.textContent = getLang().toUpperCase();
  els.ehLine.textContent = t('emptyDrop');
  els.ehOpen.textContent = t('open').replace('…', '');
  els.ehMode.textContent = t('modeToggle');
  els.ehFormatKbd.textContent = t('formatKbd');
  els.ehFormat.textContent = t('formatPanel');

  const tip = (el: HTMLElement, text: string): void => el.setAttribute('data-tip', text);
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
  tip(els.stToc, `${t('tocTitle')} · Ctrl+Shift+1`);
  els.stToc.setAttribute('aria-label', `${t('tocTitle')} · Ctrl+Shift+1`);
  // #31: the 7px modified dot gets a name on hover
  tip(els.stModified, t('unsaved'));
  els.stModified.setAttribute('aria-label', t('unsaved'));

  els.aboutModal.setAttribute('aria-label', t('versionTip'));
  els.aboutDesc.textContent = t('aboutDesc');
  els.aboutLicense.textContent = t('licenseLink');
  els.aboutCheck.textContent = t('checkUpdates');
  els.aboutClose.setAttribute('aria-label', t('closeTip'));
  tip(els.aboutClose, t('closeTip'));
  els.hotkeysClose.setAttribute('aria-label', t('closeTip'));
  tip(els.hotkeysClose, t('closeTip'));
  els.ccDontSave.textContent = t('dontSave');
  els.ccCancel.textContent = t('cancel');
  els.ccSave.textContent = t('save');
  refreshAboutVersion();
  // section labels and TOC strings are re-read from the dictionaries at
  // render time, so a rebuild re-localizes them
  menuBar.relabel();
  toc.relabel();
}

// source-mode aliases mirroring the visual editor's Milkdown keymap
// (Ctrl+1..6/0, Ctrl+Shift+B, Ctrl+Alt+7/8/C, Ctrl+B/I/E/K); returns true
// when the combo was consumed. NOT overlap-free with CodeMirror's keymaps:
// defaultKeymap also binds Mod-/ (toggleComment) and Mod-i
// (selectParentSyntax) — both are swallowed in source.ts with a
// high-precedence keymap so they can't fire before these aliases run.
function sourceHotkey(code: string, shift: boolean, alt: boolean): boolean {
  if (!source) return false;
  if (!shift && !alt && /^Digit[0-6]$/.test(code)) {
    const id = (code === 'Digit0' ? 'text' : `h${Number(code.slice(5))}`) as `h${1 | 2 | 3 | 4 | 5 | 6}`;
    sourceSetBlock(source.view, id);
  } else if (shift && !alt && code === 'KeyB') {
    sourceSetBlock(source.view, 'quote');
  } else if (!shift && alt && code === 'Digit7') {
    sourceSetBlock(source.view, 'ol');
  } else if (!shift && alt && code === 'Digit8') {
    sourceSetBlock(source.view, 'ul');
  } else if (!shift && alt && code === 'KeyC') {
    sourceSetBlock(source.view, 'code');
  } else if (!shift && !alt && code === 'KeyB') {
    sourceToggleMark(source.view, 'bold');
  } else if (!shift && !alt && code === 'KeyI') {
    sourceToggleMark(source.view, 'italic');
  } else if (!shift && !alt && code === 'KeyE') {
    sourceToggleMark(source.view, 'code');
  } else if (!shift && !alt && code === 'KeyK') {
    sourceToggleMark(source.view, 'link');
  } else {
    return false;
  }
  return true;
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

  menuBar.mount(els.menubar, buildMenuSections());
  // #28: the stock Milkdown keymap binds Ctrl+Shift+B / Ctrl+Alt+8 / 7 to
  // plain wrap commands (quote-in-quote, list no-op on repeat), and Ctrl+0
  // to a plain "turn into text" that ignores quote/list nesting. Capture-
  // phase interception runs before prosemirror's keymap and routes the four
  // combos through the same toggle-aware commands the menu uses.
  window.addEventListener(
    'keydown',
    (e) => {
      if (mode !== 'visual' || activeModalOverlay() !== null) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const { code, shiftKey, altKey } = e;
      let block: BlockId | null = null;
      if (code === 'KeyB' && shiftKey && !altKey) block = 'quote';
      else if (code === 'Digit8' && altKey && !shiftKey) block = 'ul';
      else if (code === 'Digit7' && altKey && !shiftKey) block = 'ol';
      else if (code === 'Digit0' && !shiftKey && !altKey) block = 'text';
      if (!block) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      editBlock(block);
    },
    true,
  );
  toc.mount(els.editorHost, {
    getMode: () => mode,
    getVisualPane: () => els.visualPane,
    getSource: () => source,
  });
  onFeaturesChanged(() => applyTocFeature());
  applyTocFeature();
  // active-heading tracking rides the panes' scroll (capture catches the
  // inner scrollers — crepe's wrapper, .cm-scroller)
  els.visualPane.addEventListener('scroll', queueTocActive, true);
  els.sourcePane.addEventListener('scroll', queueTocActive, true);

  applyStaticTexts();
  await visual.create(
    els.visualPane,
    '',
    () => {
      scheduleToc();
      if (userInteracted) {
        markDirty();
        return;
      }
      // update without real user input behind it: not dirty, but the stats
      // and the empty-state hint must still track the actual content
      scheduleStats();
    },
    // the right-click panel's clipboard row shares the Edit-menu commands
    {
      copy: () => void editCopy(),
      cut: () => void editCut(),
      paste: () => void editPaste(),
    },
  );
  setMode('visual');

  els.btnVisual.addEventListener('click', () => setMode('visual'));
  els.btnSource.addEventListener('click', () => setMode('source'));
  els.btnLang.addEventListener('click', () => {
    setLang(getLang() === 'ru' ? 'en' : 'ru');
    applyStaticTexts();
    refreshChrome();
    // Crepe bakes its feature strings in at construction — rebuild the
    // visual editor so its menus/tooltips follow the new language (undo
    // history resets; a rare action, accepted). Works in source mode too:
    // the hidden editor rebuilds with the current content (front-matter
    // carved back out — Crepe must not see it, #33).
    const { frontMatter: fm, body } = splitFrontMatter(currentFullText());
    frontMatter = fm;
    suppressChange = true;
    void visual.rebuild(body).then(() => {
      if (mode === 'visual') visual.focus();
      window.setTimeout(() => {
        suppressChange = false;
      }, 0);
    });
  });
  els.btnTheme.addEventListener('click', () => {
    const now = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(now);
  });

  window.addEventListener('keydown', (e) => {
    // Alt+F/E/P/O/V/H open the menu sections (physical key — the RU layout
    // reports Cyrillic in e.key); suppressed while a modal dialog is up
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && activeModalOverlay() === null) {
      if (menuBar.openByAltKey(e.code)) {
        e.preventDefault();
        return;
      }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) {
      const overlay = activeModalOverlay();
      if (overlay === null) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        hideModal(overlay);
      } else if (e.key === 'Tab') {
        trapTabKey(overlay, e);
      } else if (e.key.startsWith('Arrow') && !e.shiftKey && !e.altKey) {
        moveModalFocus(overlay, e);
      }
      return;
    }
    // match the physical key (e.code), not e.key: on the RU layout the
    // same physical O reports key='щ', so a literal 'o' check would make
    // Ctrl+O layout-dependent. Note this binds by scancode position — a
    // software-remapped layout (Dvorak etc.) gets the physical key, an
    // accepted trade-off
    const code = e.code;
    // editor-touching aliases are dead while a modal dialog is up
    const modalOpen = activeModalOverlay() !== null;
    if (code === 'KeyS') {
      e.preventDefault();
      void saveFile(e.shiftKey);
    } else if (code === 'KeyO') {
      e.preventDefault();
      void openFile();
    } else if (code === 'Slash') {
      e.preventDefault();
      toggleMode();
    } else if (code === 'KeyN' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void newFile();
    } else if (code === 'Digit1' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleToc();
    } else if (modalOpen === false && code === 'KeyW' && !e.shiftKey && !e.altKey) {
      // Ctrl+W goes through the OS close path — the unsaved-changes guard
      // (onCloseRequested) intercepts it exactly like the × button
      e.preventDefault();
      void currentWindow?.close().catch(() => {});
    } else if (modalOpen === false && code === 'KeyD' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      editDeleteLine();
    } else if (modalOpen === false && code === 'KeyL' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      editToggleTask();
    } else if (modalOpen === false && code === 'KeyN' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      editClearFormatting();
    } else if (modalOpen === false && code === 'KeyX' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      editMark('strike');
    } else if (modalOpen === false && code === 'KeyM' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      editMark('code');
    } else if (modalOpen === false && code === 'KeyL' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      editBlock('ul');
    } else if (modalOpen === false && code === 'KeyQ' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      editBlock('quote');
    } else if (modalOpen === false && code === 'Period' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      editBlock('quote');
    } else if (mode === 'source' && sourceHotkey(code, e.shiftKey, e.altKey)) {
      e.preventDefault();
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
  // statusbar outline toggle — same code path as View → Outline
  els.stToc.addEventListener('click', () => toggleToc());
  els.aboutClose.addEventListener('click', () => hideModal(els.aboutOverlay));
  els.aboutCheck.addEventListener('click', () => {
    hideModal(els.aboutOverlay);
    void checkForUpdates(true);
  });
  els.aboutOverlay.addEventListener('click', (e) => {
    if (e.target === els.aboutOverlay) hideModal(els.aboutOverlay);
  });

  // hotkeys dialog shares the modal mechanics (Escape/Tab trap come from
  // the central keydown handler via activeModalOverlay)
  els.hotkeysClose.addEventListener('click', () => hideModal(els.hotkeysOverlay));
  els.hotkeysOverlay.addEventListener('click', (e) => {
    if (e.target === els.hotkeysOverlay) hideModal(els.hotkeysOverlay);
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

    // #34: the primary content has landed and will paint in this frame —
    // reveal the window now (it starts hidden, see tauri.conf.json/lib.rs,
    // so the white WebView2 flash and the empty-shell frame never show).
    // The Rust fallback timer shows it even if this script never runs.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void currentWindow?.show().catch(() => {});
      }),
    );

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

  // #34: the initial file (if any) has been applied — the honest empty
  // state may replace the pending loader
  delete els.app.dataset.pending;
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
