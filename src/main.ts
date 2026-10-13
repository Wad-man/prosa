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
  writeHtml as writeClipboardHtml,
} from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { VisualEditor } from './editor/visual';
import { SourceEditor } from './editor/source';
import { setImageContext } from './editor/image-assets';
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
import { markdownToHtml } from './markdown-html';
import { MenuBar, type MenuSection } from './menu';
import { TocPanel } from './toc';
import { isFeatureEnabled, setFeatureEnabled, onFeaturesChanged } from './features';
import { applyWebView2DragFix } from './platform/webview2-dnd';
import { getLang, t } from './i18n';
import { applyTheme, currentTheme, onLangChanged, setLanguage, toggleTheme } from './settings';
import { FindReplaceBar } from './search';
import { initZoom, zoomIn, zoomOut, zoomReset } from './zoom';
import './styles.css';

// Must run before the editors mount: it re-routes DataTransfer writes so
// HTML5 drag-and-drop survives inside the WebView2 shell (see module comment).
applyWebView2DragFix();

// #66: three modes, Obsidian-style — reading (the visual editor made
// non-editable), visual editing and source code. Reading and the visual
// editor share one VisualEditor instance: switching between them
// only flips `editable`, the document is never re-parsed.
type Mode = 'reading' | 'visual' | 'source';
const MODE_CYCLE: Mode[] = ['reading', 'visual', 'source'];

/** The pane a mode renders in — reading lives in the visual pane. */
const paneOf = (m: Mode): 'visual' | 'source' => (m === 'source' ? 'source' : 'visual');

const MD_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }];
const MD_PATH_RE = /\.(md|markdown|mdown|mkd|txt)$/i;

// Online help destination of the Help (F1) window (#107): the site's
// Markdown docs hub; to be re-pointed at the full manual once site#4 lands
const HELP_URL = 'https://prosamd.ru/markdown/';

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
  btnTheme: $('btn-theme') as HTMLButtonElement,
  btnReading: $('btn-mode-reading') as HTMLButtonElement,
  btnVisual: $('btn-mode-visual') as HTMLButtonElement,
  btnSource: $('btn-mode-source') as HTMLButtonElement,
  modeSwitch: $('mode-switch'),
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
  stHotkeys: $('st-hotkeys') as HTMLButtonElement,
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
  settingsOverlay: $('settings-overlay'),
  settingsModal: document.querySelector('#settings-overlay .modal') as HTMLElement,
  settingsClose: $('settings-close') as HTMLButtonElement,
  settingsTitle: $('settings-title'),
  settingsLangLabel: $('settings-lang-label'),
  settingsLangRu: $('settings-lang-ru') as HTMLButtonElement,
  settingsLangEn: $('settings-lang-en') as HTMLButtonElement,
};

const visual = new VisualEditor();
let source: SourceEditor | null = null; // lazily created on first switch
const menuBar = new MenuBar();
const toc = new TocPanel();
// #32: constructed early (installs the window-capture keydown), built
// lazily on the first open; the closures read the live mode/editor state
const findBar = new FindReplaceBar({
  visual,
  getSource: () => source,
  getMode: () => mode,
  isOverlayOpen: () => activeModalOverlay() !== null,
  onEdited: () => markDirty(),
  selectionText,
  focusEditor: focusActiveEditor,
});

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
// #83(а): a closed `---` block at byte 0 with blank lines inside — held
// byte-for-byte and re-attached on save, but never shown to the editors
// (not even the #fm-view record): remark would rewrite its YAML fields
// into headings, silently corrupting Jekyll/Hugo files on save
let unparsedPrefix: string | null = null;
let savedRaw = '';
let baseline = '';
let editedSinceSave = false;
let dirtyCheckTimer: number | undefined;

/**
 * #83 review: a prefix/front-matter block that ended at EOF carries no
 * trailing newline — when the user later adds body text, the join must not
 * glue it onto the closing fence. One separator byte, inserted only when
 * both sides are non-empty (an untouched document keeps its savedRaw
 * passthrough and never passes through here on save).
 */
function withSeparator(block: string, body: string): string {
  if (block === '' || body === '') return block + body;
  return block.endsWith('\n') ? block + body : block + '\n' + body;
}

/** The document as a file: the unparsed prefix (if any) + front-matter +
 * the active editor's content. In the source mode the editor part is the
 * raw body text itself; in the visual mode it is Crepe's serialization of
 * the body with the front-matter block re-attached. */
function currentFullText(): string {
  if (mode === 'source') return withSeparator(unparsedPrefix ?? '', source?.getContent() ?? '');
  return withSeparator(unparsedPrefix ?? '', withSeparator(frontMatter ?? '', visual.getMarkdown()));
}

/**
 * #86 review: the paste anchor legitimately clears `dirty`, but an
 * untitled window with content on screen holds text that exists nowhere
 * on disk — the close/new/update guards must still treat it as unsaved.
 */
function unsavedContent(): boolean {
  return dirty || (filePath === null && currentFullText().trim() !== '');
}

/**
 * #71: put the caret into the editor of the current mode — "opened the
 * app, start typing", Notepad/Typora style. DOM focus set while the window
 * was still hidden (setMode during init) does not reliably survive the
 * WebView2 becoming visible, so this re-runs after show() and after a file
 * lands in this window. Reading keeps its no-caret rule (setMode's blur).
 */
function focusActiveEditor(): void {
  if (mode === 'visual') visual.focus();
  else if (mode === 'source') source?.focus();
}

/**
 * The carved-out front-matter block rendered above the document in the
 * visual pane (visible in both the visual editor and reading, #49/#66): a
 * quiet service record showing the block's raw bytes. It deliberately lives
 * OUTSIDE ProseMirror — the model must never round-trip the block (#33) —
 * so it is a plain DOM element the pane owns; editing stays in the source
 * mode, where the block is part of the raw text.
 */
function refreshFrontMatterView(): void {
  const existing = document.getElementById('fm-view');
  if (frontMatter === null) {
    existing?.remove();
    return;
  }
  const view = existing ?? document.createElement('div');
  if (!existing) {
    view.id = 'fm-view';
    els.visualPane.insertBefore(view, els.visualPane.firstChild);
  }
  // the raw block, fences included; the box adds its own bottom spacing, so
  // the display drops the block's final newline AND the blank gap lines the
  // carve absorbed after the closing fence (display-only — saving keeps
  // every byte)
  view.textContent = frontMatter.replace(/(?:[ \t]*\r?\n)+$/, '');
}

function fileName(): string {
  if (filePath !== null) return filePath.split(/[\\/]/).pop() ?? t('untitled');
  return fileSuggestion ?? t('untitled');
}

/** Directory part of a filesystem path; null when there is no separator. */
function dirOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : null;
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
  // #43: a rejected setTitle (missing capability) must surface in dev tools,
  // not vanish — that silence hid the missing permission for releases
  if (nw) void nw.setTitle(title).catch((err) => console.warn('setTitle failed:', err));
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
    } else if (filePath === null && baseline !== '' && currentFullText().trim() === '') {
      // #86: an untitled document emptied again is pristine — void the
      // paste anchor so a save writes an empty file, not the stale
      // pasted bytes (the passthrough would have used savedRaw)
      savedRaw = '';
      baseline = '';
      dirty = false;
      editedSinceSave = false;
      refreshChrome();
      reportDocState();
    }
  }, 350);
}

// #86: a paste into a pristine untitled document is new content, not an
// edit of emptiness — once it settles it becomes the clean state, so an
// undo back to the pasted text clears the unsaved dot exactly like a full
// undo after loading a file. The clean state is SNAPSHOT right after the
// paste lands (task 0 — the paste is processed synchronously); if the user
// typed anything before the 350 ms check, the content no longer matches
// and the anchor never fires. Only the FIRST content ever pasted into the
// empty document anchors (baseline === '' gate); typing never passes here.
let pasteAnchorTimer: number | undefined;
function schedulePasteAnchor(): void {
  let snapshot = '';
  window.setTimeout(() => {
    snapshot = currentFullText();
  }, 0);
  window.clearTimeout(pasteAnchorTimer);
  pasteAnchorTimer = window.setTimeout(() => {
    if (filePath !== null || suppressChange || baseline !== '') return;
    const current = currentFullText();
    if (current.trim() === '' || current !== snapshot) return;
    savedRaw = current;
    baseline = current;
    editedSinceSave = false;
    if (dirty) {
      dirty = false;
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
    // unsavedContent (#86 review): an anchored paste clears `dirty`, but
    // the Rust side routes files and warns before update force-closes —
    // untitled on-screen content must count
    dirty: unsavedContent(),
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
  if (!unsavedContent()) return true;
  return await ask(t('discardQuestion'), { title: t('discardTitle'), kind: 'warning' });
}

function applyLoaded(text: string, path: string | null, suggestedName?: string): void {
  suppressChange = true;
  savedRaw = text;
  // the visual editor must not see the front-matter block (#33) nor the
  // #83 unparsed prefix; the raw source view keeps the front-matter as
  // part of the file text (the prefix stays hidden there too — it is
  // untouchable file-level state, byte-for-byte on save)
  const { frontMatter: fm, unparsedPrefix: up, body } = splitFrontMatter(text);
  frontMatter = fm;
  unparsedPrefix = up;
  // #68: image nodeViews resolve their display src (displaySrc) against the
  // document folder SYNCHRONOUSLY inside setMarkdown below — the path must
  // already be set, or every image keeps a raw relative src forever (the
  // nodeView only rebinds when its node changes)
  filePath = path;
  fileSuggestion = path === null ? (suggestedName ?? null) : null;
  if (paneOf(mode) === 'visual') visual.setMarkdown(body);
  else source?.setContent((fm ?? '') + body);
  refreshFrontMatterView();
  // a new document invalidates the open search — close the bar quietly
  findBar.close();
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
    // #71: a document landing in this window puts the caret at its start
    // (file open, drop, Ctrl+N, __prosaOpen into a pristine window)
    focusActiveEditor();
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

// #63: two-flavor write — text/html for Word/mailers with the markdown
// source as the plain-text fallback; the browser branch mirrors the plugin
// (Chromium packs both MIME flavors into the OS clipboard)
async function writeClipboardRich(html: string, plain: string): Promise<boolean> {
  try {
    if (inTauri) await writeClipboardHtml(html, plain);
    else
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
    return true;
  } catch {
    if (inTauri) void message(t('clipboardError'), { title: 'ProsaMD', kind: 'error' });
    return false;
  }
}

// ---------- mode-aware command dispatch for the menu bar ----------
// #66: the reading mode shares the visual editor but is read-only — the
// selection/copy commands work there, every editing command is a no-op
// (ProseMirror's `editable: false` only blocks DOM input, not dispatched
// commands, so the guard must live here).

function editUndoRedo(which: 'undo' | 'redo'): void {
  if (mode === 'visual') visual.undoRedo(which);
  else if (mode === 'source' && source) sourceUndoRedo(source.view, which);
}

function editSelectAll(): void {
  if (paneOf(mode) === 'visual') visual.selectAll();
  else if (source) sourceSelectAll(source.view);
}

function selectionText(): string {
  if (paneOf(mode) === 'visual') return visual.selectionText();
  return source ? sourceSelectionText(source.view) : '';
}

// #47: like Obsidian, copy/cut always carry markdown in the visual mode (the
// native Ctrl+C path already did — this unifies the menu and right-click
// panel with it); the source mode is raw markdown by nature
function copyPayload(): string {
  if (paneOf(mode) === 'visual') return visual.selectionMarkdown() || selectionText();
  return selectionText();
}

async function editCopy(): Promise<void> {
  await writeClipboard(copyPayload());
}

async function editCut(): Promise<void> {
  if (mode === 'reading') return;
  if (await writeClipboard(copyPayload())) {
    if (mode === 'visual') visual.deleteSelection();
    else if (source) sourceDeleteSelection(source.view);
  }
}

// #63 «Копировать для Word»: rich-text flavor of the selection — or the whole
// document when nothing is selected. Ctrl+C stays markdown-only (#47); the
// HTML is built from the markdown source, so it matches what the visual mode
// renders, and skips front-matter (YAML has no Word meaning; the plain-text
// fallback keeps it)
async function editCopyForWord(): Promise<void> {
  const md = copyPayload() || currentFullText();
  if (!md.trim()) return;
  const { body } = splitFrontMatter(md);
  await writeClipboardRich(markdownToHtml(body), md);
}

// Markdown-aware in visual mode (pasted markdown renders), plain in source
async function editPaste(): Promise<void> {
  const text = await readClipboard();
  if (text === null || text === '') return;
  // #86: evaluate the pristine-untitled gate BEFORE the insertion lands
  const intoPristine = filePath === null && !dirty && currentFullText().trim() === '';
  if (mode === 'visual') visual.insertMarkdown(text);
  else if (mode === 'source' && source) sourceInsertText(source.view, text);
  if (intoPristine) schedulePasteAnchor();
}

function editBlock(id: BlockId): void {
  if (mode === 'visual') visual.applyBlock(id);
  else if (mode === 'source' && source) sourceSetBlock(source.view, id);
}

function editMark(id: MarkId): void {
  if (mode === 'visual') visual.toggleMark(id);
  else if (mode === 'source' && source) sourceToggleMark(source.view, id);
}

// ---------- line-level commands (#35 aliases: Obsidian / Word / Telegram) ----------

function editDeleteLine(): void {
  if (mode === 'visual') visual.deleteBlock();
  else if (mode === 'source' && source) sourceDeleteLines(source.view);
}

function editToggleTask(): void {
  if (mode === 'visual') visual.toggleTask();
  else if (mode === 'source' && source) sourceToggleTask(source.view);
}

function editClearFormatting(): void {
  if (mode === 'visual') visual.clearFormatting();
  else if (mode === 'source' && source) sourceClearFormatting(source.view);
}

function currentBlock(): BlockId | null {
  if (paneOf(mode) === 'visual') return visual.currentBlock();
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
        { label: t('copyForWord'), action: () => void editCopyForWord() },
        sep(),
        { label: t('findMenu'), hotkey: 'Ctrl+F', action: () => findBar.open(false) },
        { label: t('findReplaceMenu'), hotkey: 'Ctrl+H', action: () => findBar.open(true) },
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
        // #66: Ctrl+/ cycles reading → visual → source; the three
        // entries below pick a mode directly
        { label: t('modeCycle'), hotkey: 'Ctrl+/', action: () => toggleMode() },
        ...MODE_CYCLE.map((m) => ({
          label: t(m),
          action: () => setMode(m),
          checked: () => mode === m,
        })),
        sep(),
        {
          label: t('themeLight'),
          action: () => applyTheme('light'),
          checked: () => currentTheme() !== 'dark',
        },
        {
          label: t('themeDark'),
          action: () => applyTheme('dark'),
          checked: () => currentTheme() === 'dark',
        },
        sep(),
        // #25: zoom ladder (reset lives on Ctrl+Num0 — Ctrl+0 is the
        // "plain text" block command in both editing modes)
        { label: t('zoomIn'), hotkey: 'Ctrl+=', action: zoomIn },
        { label: t('zoomOut'), hotkey: 'Ctrl+−', action: zoomOut },
        { label: t('zoomReset'), hotkey: 'Ctrl+Num0', action: zoomReset },
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
        { label: t('settings'), hotkey: 'Ctrl+,', action: () => openSettings() },
        { label: t('hotkeys'), hotkey: 'F1', action: () => openHotkeys() },
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
    // a .deb install has no in-app update path: the updater would download
    // the AppImage and die on install (#105 review); deb users install the
    // next package. APPIMAGE is set only inside an AppImage launch.
    try {
      if (!(await invoke<boolean>('is_updater_install'))) {
        if (manual) void message(t('updateDebPackage'), { title: 'ProsaMD', kind: 'info' });
        return;
      }
    } catch {
      // command unavailable — behave as before
    }
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
  // reading ↔ visual stays in the same pane and instance: no content
  // hand-over, no re-parse — the document (and its dirty state) is untouched.
  // Same-mode calls still normalize the UI classes below.
  if (paneOf(next) !== paneOf(mode)) {
    const md = currentFullText();
    suppressChange = true;
    if (next === 'source') {
      // the raw view shows the whole file — front-matter included, but NOT
      // the #83 unparsed prefix (hidden file-level state; currentFullText
      // re-attaches it on top of whatever the source editor holds). The
      // slice inverts withSeparator exactly: when the prefix ends at EOF
      // (no newline), the composed text carries one injected separator
      // byte — skip it, or the source view gains a phantom leading blank
      // line and saves drift from the visual mode by one byte
      let raw = md;
      if (unparsedPrefix !== null) {
        raw = md.slice(unparsedPrefix.length);
        if (!unparsedPrefix.endsWith('\n') && raw.startsWith('\n')) raw = raw.slice(1);
      }
      if (source === null)
        source = new SourceEditor(els.sourcePane, raw, () => {
          markDirty();
          scheduleToc();
          findBar.notifyDocChanged();
        });
      else source.setContent(raw);
    } else {
      // leaving the raw view: re-split — the front-matter may have been
      // edited (or removed, or gained a blank line) as plain text. The
      // prefix is prepended by currentFullText, so a still-blank-lined
      // block re-carves as the prefix and survives byte-for-byte
      const { frontMatter: fm, unparsedPrefix: up, body } = splitFrontMatter(md);
      frontMatter = fm;
      unparsedPrefix = up;
      visual.setMarkdown(body);
      refreshFrontMatterView();
    }
    window.setTimeout(() => {
      suppressChange = false;
    }, 0);
  }
  mode = next;
  visual.setReadonly(mode === 'reading');
  els.visualPane.classList.toggle('active', paneOf(mode) === 'visual');
  els.sourcePane.classList.toggle('active', mode === 'source');
  const buttons: [HTMLButtonElement, Mode][] = [
    [els.btnReading, 'reading'],
    [els.btnVisual, 'visual'],
    [els.btnSource, 'source'],
  ];
  for (const [btn, m] of buttons) {
    btn.classList.toggle('active', mode === m);
    btn.setAttribute('aria-selected', String(mode === m));
  }
  els.modeSwitch.dataset.active = mode;
  els.app.dataset.mode = mode;
  if (mode === 'visual') visual.focus();
  else if (mode === 'source') source?.focus();
  // reading: no caret anywhere — and ProseMirror only mirrors a read-only
  // selection (mouse drag, Ctrl+A) when focus is not parked on some other
  // element such as the mode button that was just clicked
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  refreshChrome();
  // heading sources differ per mode (live DOM vs text scan)
  toc.refresh();
  // #32: the open search follows into the now-active pane (and picks up
  // the read-only replace lock of the reading mode)
  findBar.reattach();
}

function toggleMode(): void {
  setMode(MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]);
}

// ---------- modals ----------

let modalReturnFocus: HTMLElement | null = null;

function activeModalOverlay(): HTMLElement | null {
  if (!els.aboutOverlay.hidden) return els.aboutOverlay;
  if (!els.closeOverlay.hidden) return els.closeOverlay;
  if (!els.hotkeysOverlay.hidden) return els.hotkeysOverlay;
  if (!els.settingsOverlay.hidden) return els.settingsOverlay;
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
  // the return-focus node can be gone (e.g. the language switch rebuilt
  // the visual editor while the dialog was open) — fall back to the
  // editor of the current mode instead of dropping focus on <body>
  if (back && back.isConnected) back.focus();
  else if (mode === 'visual') visual.focus();
  else if (mode === 'source') source?.focus();
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

  // online help (#107): the dialog is a help window — the shortcut list
  // plus a link out to the site docs; opens in the system browser
  const link = document.createElement('a');
  link.className = 'hk-online';
  link.href = HELP_URL;
  link.textContent = t('helpOnline');
  link.addEventListener('click', (e) => {
    e.preventDefault();
    openExternal(HELP_URL);
  });
  body.append(link);
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
  // titled "Help" (#107): the window carries the shortcut list plus the
  // online-help link, not shortcuts alone
  els.hotkeysTitle.textContent = t('help');
  buildHotkeysBody();
  showModal(els.hotkeysOverlay, els.hotkeysModal);
}

// ---------- settings dialog (#87, #88) ----------

/** Opens the Settings dialog. Unlike the hotkeys dialog its content is not
 * rebuilt per open — texts and the pressed language mark are maintained by
 * applyStaticTexts, so they already follow any live language switch (even
 * one made from inside the dialog itself). */
function openSettings(): void {
  showModal(els.settingsOverlay, els.settingsModal);
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

/** #70: an outline mouse with the right button filled (Lucide "mouse"
 * geometry, MIT — the same stroke style as the toolbar icons). The fill is
 * currentColor, so it follows the kbd text color in both themes. */
function formatKbdIcon(): string {
  const label = t('formatMouse');
  return (
    `<svg class="icon-mouse" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" ` +
    `aria-label="${label}">` +
    `<rect x="5" y="2" width="14" height="20" rx="7"/>` +
    `<path d="M5 9h14"/>` +
    `<path d="M12 2v7"/>` +
    `<path d="M12 12v3"/>` +
    `<path d="M12 2a7 7 0 0 1 7 7H12Z" fill="currentColor" stroke="none"/>` +
    `</svg>`
  );
}

function applyStaticTexts(): void {
  document.documentElement.lang = getLang();
  document.getElementById('toolbar')?.setAttribute('aria-label', t('toolbar'));
  els.menubar.setAttribute('aria-label', t('menuBar'));
  els.modeSwitch.setAttribute('aria-label', t('modeToggle'));
  els.ehLine.textContent = t('emptyDrop');
  els.ehOpen.textContent = t('open').replace('…', '');
  els.ehMode.textContent = t('modeToggle');
  // #70: the «ПКМ/RMB» abbreviation is a mouse glyph with the right button
  // filled — a pictogram reads without translation; the kbd keeps the
  // abbreviated text as visually-hidden copy for screen readers
  els.ehFormatKbd.innerHTML = `<span class="sr-only">${t('formatKbd')}</span>${formatKbdIcon()}`;
  els.ehFormatKbd.title = t('formatMouse');
  els.ehFormat.textContent = t('formatPanel');

  const tip = (el: HTMLElement, text: string): void => el.setAttribute('data-tip', text);
  tip(els.btnReading, `${t('reading')} · Ctrl+/`);
  tip(els.btnVisual, `${t('visual')} · Ctrl+/`);
  tip(els.btnSource, `${t('source')} · Ctrl+/`);
  els.btnReading.setAttribute('aria-label', t('reading'));
  els.btnVisual.setAttribute('aria-label', t('visual'));
  els.btnSource.setAttribute('aria-label', t('source'));
  tip(els.btnTheme, t('themeTip'));
  els.btnTheme.setAttribute('aria-label', t('themeTip'));

  els.stPath.textContent = filePath ?? t('untitled');
  els.stVersion.title = t('versionTip');
  els.stVersion.setAttribute('aria-label', t('versionTip'));
  tip(els.stToc, `${t('tocTitle')} · Ctrl+Shift+1`);
  els.stToc.setAttribute('aria-label', `${t('tocTitle')} · Ctrl+Shift+1`);
  // #23: the shortcuts list is one click away in the statusbar; the tip
  // carries the F1 binding (the menu entry lists it too)
  tip(els.stHotkeys, `${t('help')} · F1`);
  els.stHotkeys.setAttribute('aria-label', `${t('help')} · F1`);
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
  els.settingsTitle.textContent = t('settingsTitle');
  els.settingsLangLabel.textContent = t('settingsLangSection');
  els.settingsLangRu.textContent = t('langRu');
  els.settingsLangEn.textContent = t('langEn');
  // the pressed button mirrors the live language (#88)
  els.settingsLangRu.setAttribute('aria-pressed', String(getLang() === 'ru'));
  els.settingsLangEn.setAttribute('aria-pressed', String(getLang() === 'en'));
  els.settingsClose.setAttribute('aria-label', t('closeTip'));
  tip(els.settingsClose, t('closeTip'));
  els.ccDontSave.textContent = t('dontSave');
  els.ccCancel.textContent = t('cancel');
  els.ccSave.textContent = t('save');
  refreshAboutVersion();
  // section labels and TOC strings are re-read from the dictionaries at
  // render time, so a rebuild re-localizes them
  menuBar.relabel();
  toc.relabel();
  // #32: the find bar (a no-op before its first open)
  findBar.relabel();
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
  // #25: apply the persisted zoom before the first meaningful paint
  initZoom();
  // #68: the visual editor's image layer (display resolution + paste/drop
  // persistence) resolves against this window's document folder
  setImageContext({
    getDocDir: () => (filePath === null ? null : dirOf(filePath)),
    ensureSaved: async () => {
      const save = await ask(t('imgSaveQuestion'), { title: t('imgSaveTitle'), kind: 'info' });
      if (!save) return false;
      await saveFile(true);
      return filePath !== null;
    },
  });

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
      if (mode !== 'visual' || activeModalOverlay() !== null || findBar.hasFocus()) return;
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
    getMode: () => paneOf(mode),
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
      findBar.notifyDocChanged();
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
    // #49: a whole-document paste into the empty visual editor hands its
    // front-matter block to the file-level bookkeeping (and the service
    // record above the document). R1: the sink REFUSES when a block
    // already exists — a paste must never silently replace it (the block
    // lives outside ProseMirror's undo history); the editor then runs the
    // stock paste path instead. #83: a blank-lined block adopts the
    // unparsed-prefix slot instead — same refusal rule.
    (fm, prefix) => {
      if (frontMatter !== null || unparsedPrefix !== null) return false;
      frontMatter = fm;
      unparsedPrefix = prefix;
      refreshFrontMatterView();
      return true;
    },
  );
  setMode('visual');

  els.btnReading.addEventListener('click', () => setMode('reading'));
  els.btnVisual.addEventListener('click', () => setMode('visual'));
  els.btnSource.addEventListener('click', () => setMode('source'));
  // #88: the Settings dialog flips the language via setLanguage; the whole
  // live-switch machinery lives here, registered once (it used to be the
  // #btn-lang click handler)
  onLangChanged(() => {
    applyStaticTexts();
    refreshChrome();
    // the native macOS menu re-localizes from the resolved language (#104);
    // a no-op command wherever there is no native menu
    if (inTauri) void invoke('set_menu_language', { lang: getLang() }).catch(() => {});
    // Crepe bakes its feature strings in at construction — rebuild the
    // visual editor so its menus/tooltips follow the new language (undo
    // history resets; a rare action, accepted). Works in source mode too:
    // the hidden editor rebuilds with the current content (front-matter
    // carved back out — Crepe must not see it, #33; the #83 prefix is
    // carved out by the same split)
    const { frontMatter: fm, unparsedPrefix: up, body } = splitFrontMatter(currentFullText());
    frontMatter = fm;
    unparsedPrefix = up;
    suppressChange = true;
    void visual
      .rebuild(body)
      .then(() => {
        // rebuild wipes the pane (visual.rebuild replaceChildren) — bring the
        // front-matter record back above the fresh editor
        refreshFrontMatterView();
        // #32: the rebuild destroyed the search decorations — re-apply
        findBar.reattach();
        // with a modal open (settings dialog) the focus must stay inside it,
        // otherwise typing goes "blind" into the document under the overlay
        const openOverlay = activeModalOverlay();
        if (openOverlay) openOverlay.querySelector<HTMLElement>('.modal')?.focus();
        else if (mode === 'visual') visual.focus();
      })
      .catch((err: unknown) => console.error('visual.rebuild failed:', err))
      .finally(() => {
        // reset in every branch — a stuck flag would freeze dirty tracking
        window.setTimeout(() => {
          suppressChange = false;
        }, 0);
      });
  });
  els.btnTheme.addEventListener('click', () => toggleTheme());
  // #86: real Ctrl+V pastes in either editor — the capture-phase event
  // fires before the editor consumes it, so the pristine-untitled gate
  // still sees the pre-paste (empty) document
  window.addEventListener(
    'paste',
    () => {
      if (filePath === null && !dirty && currentFullText().trim() === '') schedulePasteAnchor();
    },
    true,
  );

  window.addEventListener('keydown', (e) => {
    // Alt+F/E/P/O/V/H open the menu sections (physical key — the RU layout
    // reports Cyrillic in e.key); suppressed while a modal dialog is up
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && activeModalOverlay() === null) {
      if (menuBar.openByAltKey(e.code)) {
        e.preventDefault();
        return;
      }
    }
    // F1 opens the shortcuts list (#23) — a physical key, so the RU layout
    // can't break it (the Ctrl+? idea from the request needs Shift+7 on RU);
    // suppressed while a modal is up: showModal does not stack dialogs
    if (e.key === 'F1' && activeModalOverlay() === null) {
      e.preventDefault();
      openHotkeys();
      return;
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
    // editor-touching aliases are dead while a modal dialog is up, or while
    // the caret sits in the find bar's inputs (a non-modal surface — the
    // hotkeys must not fire into the document underneath it)
    const modalOpen = activeModalOverlay() !== null || findBar.hasFocus();
    if (code === 'KeyS') {
      e.preventDefault();
      void saveFile(e.shiftKey);
    } else if (code === 'KeyO') {
      e.preventDefault();
      void openFile();
    } else if (code === 'Slash') {
      e.preventDefault();
      toggleMode();
    } else if (!e.altKey && (code === 'Equal' || code === 'NumpadAdd')) {
      // #25: zoom ladder — works everywhere, dialogs included; AltGr
      // (Ctrl+Alt on Windows) must not zoom while typing
      e.preventDefault();
      zoomIn();
    } else if (!e.altKey && (code === 'Minus' || code === 'NumpadSubtract')) {
      e.preventDefault();
      zoomOut();
    } else if (!e.altKey && !e.shiftKey && code === 'Numpad0') {
      // reset is Ctrl+Num0: Ctrl+0 stays the "plain text" block command
      e.preventDefault();
      zoomReset();
    } else if (code === 'KeyN' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void newFile();
    } else if (code === 'Digit1' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleToc();
    } else if (modalOpen === false && code === 'Comma' && !e.shiftKey && !e.altKey) {
      // Ctrl+, opens Settings (#87) — the VS Code convention; the combo is
      // free (no editor keymap or browser shortcut claims it, unlike the
      // taken Ctrl+/)
      e.preventDefault();
      openSettings();
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
    } else if (modalOpen === false && mode === 'reading' && code === 'KeyA' && !e.shiftKey && !e.altKey) {
      // #66: the read-only view gets no keymap from ProseMirror — the
      // native Ctrl+A would select the whole window chrome; select the
      // document instead (Ctrl+C then copies it as markdown, #47)
      e.preventDefault();
      editSelectAll();
    } else if (modalOpen === false && mode === 'source' && sourceHotkey(code, e.shiftKey, e.altKey)) {
      e.preventDefault();
    }
  });

  // #66: links are live in the reading mode (Obsidian) — a plain click on
  // an external link opens it in the system browser; without this the
  // non-editable view would let the WebView itself navigate away from the
  // document. Internal `#` anchors are visual.ts's business (#59).
  els.visualPane.addEventListener(
    'click',
    (e) => {
      if (mode !== 'reading') return;
      const a = (e.target as Element | null)?.closest?.('.ProseMirror a[href]') as HTMLAnchorElement | null;
      if (!a || a.getAttribute('href')?.startsWith('#')) return;
      e.preventDefault();
      if (/^(https?|mailto):$/.test(a.protocol)) openExternal(a.href);
    },
    true,
  );

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
    if (!MD_PATH_RE.test(file.name)) {
      // #68: an image dropped into the visual editor is inserted by the
      // upload plugin (saved to assets/ next to the document); the
      // not-a-markdown nag stays for drops elsewhere (chrome, source mode)
      const intoVisualEditor =
        mode === 'visual' &&
        e.target instanceof Element &&
        e.target.closest('#visual-editor') !== null;
      if (!intoVisualEditor) {
        void message(t('notMarkdown'), { title: 'ProsaMD', kind: 'info' });
      }
      return;
    }
    void openDroppedFile(dt, file);
  });

  refreshChrome();
  reportDocState();

  // About dialog: the version in the statusbar opens it; the update check
  // that used to live there moved into the dialog
  els.stVersion.addEventListener('click', () => openAbout());
  // statusbar outline toggle — same code path as View → Outline
  els.stToc.addEventListener('click', () => toggleToc());
  // #23: statusbar entry point for the shortcuts list
  els.stHotkeys.addEventListener('click', () => openHotkeys());
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
  // settings dialog: same modal mechanics; the language buttons apply the
  // switch live — setLanguage runs the onLangChanged machinery above, and
  // applyStaticTexts re-labels the dialog (and its pressed mark) on the way
  els.settingsClose.addEventListener('click', () => hideModal(els.settingsOverlay));
  els.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === els.settingsOverlay) hideModal(els.settingsOverlay);
  });
  els.settingsLangRu.addEventListener('click', () => setLanguage('ru'));
  els.settingsLangEn.addEventListener('click', () => setLanguage('en'));
  // #104: native macOS menu — report the resolved language once at boot
  // (the bar starts Russian) and receive its "Settings…" item back. The
  // listener must sit on THIS window (a global listen() matches in every
  // webview, so the focused-window routing from menu.rs would leak into
  // all of them — review MAJOR-1)
  if (inTauri) {
    void invoke('set_menu_language', { lang: getLang() }).catch(() => {});
    void currentWindow?.listen<string>('prosa://menu', (e) => {
      // same modal gate as the Ctrl+, handler — no stacking over Help/About
      if (e.payload === 'settings' && activeModalOverlay() === null) openSettings();
    });
  }
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
    if (!unsavedContent() || forceClose) return;
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
        void currentWindow
          ?.show()
          .then(() => {
            // #71: a window shown from hidden does not reliably hand
            // keyboard focus to the WebView2 — the caret sat in a focused
            // element no keystroke could reach until the user clicked.
            // setFocus claims the OS-level focus (warn on rejection like
            // setTitle, #43 — the capability may be missing), then the
            // editor is re-focused now that the view is visible.
            void currentWindow?.setFocus().catch((err) => console.warn('setFocus failed:', err));
            focusActiveEditor();
          })
          .catch(() => {});
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
