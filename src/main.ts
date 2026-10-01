import {
  ask,
  message,
  open as openFileDialog,
  save as saveFileDialog,
} from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  btnOpen: $('btn-open') as HTMLButtonElement,
  btnSave: $('btn-save') as HTMLButtonElement,
  btnSaveAs: $('btn-save-as') as HTMLButtonElement,
  btnLang: $('btn-lang') as HTMLButtonElement,
  btnTheme: $('btn-theme') as HTMLButtonElement,
  btnVisual: $('btn-mode-visual') as HTMLButtonElement,
  btnSource: $('btn-mode-source') as HTMLButtonElement,
  visualPane: $('visual-editor'),
  sourcePane: $('source-editor'),
  stPath: $('st-path'),
  stCount: $('st-count'),
};

const visual = new VisualEditor();
let source: SourceEditor | null = null; // lazily created on first switch

// Crepe mounts focus/cursor widgets asynchronously, which the mutation
// observer would misread as edits; only user input can mark the doc dirty.
let userInteracted = false;

let mode: Mode = 'visual';
let filePath: string | null = null;
let dirty = false;
let suppressChange = false;
let statsTimer: number | undefined;

function getMarkdown(): string {
  if (mode === 'visual') return visual.getMarkdown();
  return source?.getContent() ?? '';
}

function fileName(): string {
  if (filePath === null) return t('untitled');
  return filePath.split(/[\\/]/).pop() ?? t('untitled');
}

function refreshChrome(): void {
  const prefix = dirty ? '• ' : '';
  const title = `${prefix}${fileName()} — Prosa`;
  document.title = title;
  const nw = nativeWindow();
  if (nw) void nw.setTitle(title).catch(() => {});
  els.stPath.textContent = filePath ?? t('untitled');
  els.btnSave.disabled = !dirty && filePath !== null;
  updateStats();
}

let statsPending = '';
function scheduleStats(): void {
  statsPending = getMarkdown();
  window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    const md = statsPending.trim();
    const words = md ? md.split(/\s+/).length : 0;
    els.stCount.textContent = `${words} ${t('words')} · ${statsPending.length} ${t('chars')}`;
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

async function loadPath(path: string): Promise<void> {
  try {
    const text = await readTextFile(path);
    suppressChange = true;
    if (mode === 'visual') visual.setMarkdown(text);
    else source?.setContent(text);
    filePath = path;
    dirty = false;
    // let programmatic editor updates land before unmasking change events
    window.setTimeout(() => {
      suppressChange = false;
      refreshChrome();
    }, 0);
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
    const defaultName = filePath === null ? `${t('untitled')}.md` : fileName();
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
  els.btnOpen.textContent = t('open');
  els.btnSave.textContent = t('save');
  els.btnSaveAs.textContent = t('saveAs');
  els.btnVisual.textContent = t('visual');
  els.btnSource.textContent = t('source');
  els.btnLang.textContent = getLang().toUpperCase();
  els.stPath.textContent = filePath ?? t('untitled');
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

  const nw = nativeWindow();
  if (nw) {
    void nw
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const dropped = event.payload.paths[0];
        if (dropped === undefined) return;
        if (!MD_PATH_RE.test(dropped)) {
          void message(t('notMarkdown'), { title: 'Prosa', kind: 'info' });
          return;
        }
        void (async () => {
          if (await confirmLoseChanges()) await loadPath(dropped);
        })();
      })
      .catch(() => {});
  }

  refreshChrome();
}

void init();
