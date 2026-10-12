// App-level find & replace (#32). One bar for all three modes: the source
// pane integrates through editor/cm-search.ts, the visual/reading pane
// through the plugin + methods on VisualEditor (visual.ts). This module
// owns the UI, the query text, the active-match index and the keyboard
// plumbing.
//
// Keyboard model (matches the editors' conventions):
//  - Ctrl+F / Ctrl+H open (H with the replace row); both refocus the bar
//    when already open. Handled in the WINDOW CAPTURE phase so it beats
//    CodeMirror's own Mod-f binding (basicSetup's search panel never
//    opens) and WebView2's native find.
//  - Enter / F3 next, Shift+Enter / Shift+F3 previous; Esc closes the bar
//    and returns focus to the editor.
//
// The bar is a mode surface, not a modal: no backdrop, no Tab trap, the
// document stays interactive while it is open (PLAN-V0.2.0 §3.5).
import { t } from './i18n';
import type { VisualEditor } from './editor/visual';
import type { SourceEditor } from './editor/source';
import { cmApplySearch, cmGoToMatch, cmMatchCount, cmReplaceAllMatches, cmReplaceMatch } from './editor/cm-search';

export interface FindReplaceDeps {
  visual: VisualEditor;
  getSource: () => SourceEditor | null;
  getMode: () => 'reading' | 'visual' | 'source';
  /** true while any modal overlay (about/hotkeys/settings/close) is up */
  isOverlayOpen: () => boolean;
  /** called after a successful replace — deterministic dirty tracking */
  onEdited: () => void;
  /** current selection text (single-line prefill for a fresh open) */
  selectionText: () => string;
  focusEditor: () => void;
}

export class FindReplaceBar {
  private readonly deps: FindReplaceDeps;
  private bar: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private replaceInput: HTMLInputElement | null = null;
  private countLabel: HTMLElement | null = null;
  private caseBtn: HTMLButtonElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private replaceRow: HTMLElement | null = null;
  private replaceBtn: HTMLButtonElement | null = null;
  private replaceAllBtn: HTMLButtonElement | null = null;

  private isOpen = false;
  private replaceVisible = false;
  private caseSensitive = false;
  private activeIndex = -1;
  private count = 0;

  constructor(deps: FindReplaceDeps) {
    this.deps = deps;
    // capture on window: runs before CodeMirror's keymaps and before the
    // app's own bubble-phase handler — the combos below are fully ours
    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
  }

  isOpenBar(): boolean {
    return this.isOpen;
  }

  /** True while the caret sits in one of the bar's inputs — the central
   * hotkey dispatch in main.ts treats it like an open modal (editor
   * commands must not fire into the document under the bar). */
  hasFocus(): boolean {
    return this.isOpen && this.bar !== null && document.activeElement !== null && this.bar.contains(document.activeElement);
  }

  /** Правка → Найти… / Ctrl+F; `withReplace` forces the replace row (Ctrl+H). */
  open(withReplace: boolean): void {
    if (this.deps.isOverlayOpen()) return;
    this.ensureBuilt();
    if (withReplace) this.replaceVisible = true;
    this.updateReplaceVisibility();
    // a fresh (re)open re-runs the search: the active index refers to the
    // previous match set and must not leak into the new one
    this.activeIndex = -1;
    if (!this.isOpen) {
      this.isOpen = true;
      this.bar!.hidden = false;
    }
    // prefill from the selection once — a fresh open with an empty input
    const input = this.input!;
    if (!input.value) {
      const sel = this.deps.selectionText();
      if (sel && !sel.includes('\n') && sel.length <= 200) input.value = sel.replace(/\r/g, '');
    }
    this.refreshEditable();
    this.applySearch();
    input.focus();
    input.select();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.bar!.hidden = true;
    this.activeIndex = -1;
    // clear BOTH panes: the hidden one keeps stale decorations otherwise
    this.deps.visual.setSearch('', false);
    const src = this.deps.getSource();
    if (src) cmApplySearch(src.view, '', false, -1);
    this.deps.focusEditor();
  }

  /** Re-apply the query to the now-active pane — after a mode switch or a
   * visual editor rebuild (language change destroys the decorations). */
  reattach(): void {
    if (!this.isOpen) return;
    // the new pane's match set is not the old one — restart navigation
    this.activeIndex = -1;
    this.refreshEditable();
    this.applySearch();
  }

  /** Live count maintenance while the document is edited under the open bar. */
  notifyDocChanged(): void {
    if (!this.isOpen) return;
    this.refreshCount();
  }

  /** Re-apply all static texts (initial mount + every language switch). */
  relabel(): void {
    if (!this.bar) return;
    this.bar.setAttribute('aria-label', t('findLabel'));
    this.input?.setAttribute('aria-label', t('findLabel'));
    this.replaceInput?.setAttribute('aria-label', t('replaceLabel'));
    this.countLabel?.setAttribute('aria-label', t('findCountLabel'));
    this.caseBtn!.title = t('matchCaseTip');
    this.caseBtn!.setAttribute('aria-label', t('matchCaseTip'));
    this.prevBtn!.title = t('findPrevTip');
    this.prevBtn!.setAttribute('aria-label', t('findPrevTip'));
    this.nextBtn!.title = t('findNextTip');
    this.nextBtn!.setAttribute('aria-label', t('findNextTip'));
    this.replaceBtn!.textContent = t('replaceBtn');
    this.replaceBtn!.title = t('replaceBtn');
    this.replaceAllBtn!.textContent = t('replaceAllBtn');
    this.replaceAllBtn!.title = t('replaceAllTip');
  }

  // ---------- internals ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const code = e.code;
    if (mod && !e.altKey && !e.shiftKey && (code === 'KeyF' || code === 'KeyH')) {
      // while a modal dialog is up the combo belongs to it (nothing binds
      // Ctrl+F/H today, but the rule keeps future dialogs safe)
      if (!this.isOpen && this.deps.isOverlayOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      this.open(code === 'KeyH');
      return;
    }
    if (!this.isOpen) return;
    if (code === 'F3' && !mod && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.prev();
      else this.next();
      return;
    }
    if (e.key === 'Escape' && !mod && !e.altKey) {
      if (this.deps.isOverlayOpen()) return; // the modal wins its own Esc
      // only when the bar itself holds focus: with focus elsewhere, Esc
      // belongs to whatever the user is in (open menu, link tooltip,
      // autocomplete) — they close on it, the bar stays
      if (!this.bar?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  private ensureBuilt(): void {
    if (this.bar) return;
    const host = document.getElementById('editor-host');
    if (!host) throw new Error('#editor-host not found');

    const bar = document.createElement('div');
    bar.id = 'find-bar';
    bar.hidden = true;

    const input = document.createElement('input');
    input.id = 'find-input';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
      this.activeIndex = -1;
      this.applySearch();
    });

    const countLabel = document.createElement('span');
    countLabel.id = 'find-count';
    countLabel.setAttribute('aria-live', 'polite');

    const caseBtn = document.createElement('button');
    caseBtn.id = 'find-case';
    caseBtn.type = 'button';
    caseBtn.className = 'find-btn find-btn-case';
    caseBtn.setAttribute('aria-pressed', 'false');
    caseBtn.addEventListener('click', () => {
      this.caseSensitive = !this.caseSensitive;
      caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
      this.activeIndex = -1;
      this.applySearch();
      input.focus();
    });

    const prevBtn = iconButton('find-prev', 'find-btn', chevronUpSvg);
    prevBtn.addEventListener('click', () => this.prev());
    const nextBtn = iconButton('find-next', 'find-btn', chevronDownSvg);
    nextBtn.addEventListener('click', () => this.next());

    const closeBtn = iconButton('find-close', 'find-btn', closeSvg);
    closeBtn.addEventListener('click', () => this.close());

    const row = document.createElement('div');
    row.className = 'find-row';
    row.append(input, countLabel, caseBtn, prevBtn, nextBtn, closeBtn);

    const replaceInput = document.createElement('input');
    replaceInput.id = 'replace-input';
    replaceInput.type = 'text';
    replaceInput.spellcheck = false;
    replaceInput.autocomplete = 'off';

    const replaceBtn = document.createElement('button');
    replaceBtn.id = 'replace-btn';
    replaceBtn.type = 'button';
    replaceBtn.className = 'find-btn find-btn-text';
    replaceBtn.addEventListener('click', () => this.replaceCurrent());

    const replaceAllBtn = document.createElement('button');
    replaceAllBtn.id = 'replace-all-btn';
    replaceAllBtn.type = 'button';
    replaceAllBtn.className = 'find-btn find-btn-text';
    replaceAllBtn.addEventListener('click', () => this.replaceAll());

    const replaceRow = document.createElement('div');
    replaceRow.className = 'find-row find-row-replace';
    replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);

    // Enter inside the bar walks matches; Shift+Enter walks backwards
    bar.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) this.prev();
        else this.next();
      }
    });

    bar.append(row, replaceRow);
    host.append(bar);

    this.bar = bar;
    this.input = input;
    this.replaceInput = replaceInput;
    this.countLabel = countLabel;
    this.caseBtn = caseBtn;
    this.prevBtn = prevBtn;
    this.nextBtn = nextBtn;
    this.replaceRow = replaceRow;
    this.replaceBtn = replaceBtn;
    this.replaceAllBtn = replaceAllBtn;
    this.relabel();
  }

  private updateReplaceVisibility(): void {
    this.replaceRow!.hidden = !this.replaceVisible;
  }

  /** Replace is editing — dead in the read-only Просмотр mode. */
  private refreshEditable(): void {
    const ro = this.deps.getMode() === 'reading';
    if (this.replaceInput) this.replaceInput.disabled = ro;
    if (this.replaceBtn) this.replaceBtn.disabled = ro;
    if (this.replaceAllBtn) this.replaceAllBtn.disabled = ro;
  }

  private applySearch(): void {
    const query = this.input ? this.input.value : '';
    if (this.deps.getMode() === 'source') {
      const src = this.deps.getSource();
      this.count = src ? cmApplySearch(src.view, query, this.caseSensitive, this.activeIndex) : 0;
    } else {
      this.deps.visual.setSearch(query, this.caseSensitive);
      this.count = this.deps.visual.searchMatchCount();
    }
    this.updateCountLabel();
  }

  private refreshCount(): void {
    if (this.deps.getMode() === 'source') {
      const src = this.deps.getSource();
      this.count = src ? cmMatchCount(src.view) : 0;
    } else {
      this.count = this.deps.visual.searchMatchCount();
    }
    if (this.activeIndex >= this.count) this.activeIndex = this.count - 1;
    this.updateCountLabel();
  }

  private updateCountLabel(): void {
    if (!this.countLabel || !this.input) return;
    const label =
      this.count === 0 ? '0' : this.activeIndex >= 0 ? `${this.activeIndex + 1}/${this.count}` : `${this.count}`;
    this.countLabel.textContent = label;
    this.input.classList.toggle('find-zero', this.count === 0 && this.input.value !== '');
  }

  private next(): void {
    if (this.count === 0) return;
    this.goTo(this.activeIndex < 0 ? 0 : (this.activeIndex + 1) % this.count);
  }

  private prev(): void {
    if (this.count === 0) return;
    this.goTo(this.activeIndex < 0 ? this.count - 1 : (this.activeIndex - 1 + this.count) % this.count);
  }

  private goTo(index: number): void {
    this.activeIndex = index;
    if (this.deps.getMode() === 'source') {
      const src = this.deps.getSource();
      if (src) cmGoToMatch(src.view, index);
    } else {
      this.deps.visual.setSearchActive(index);
    }
    this.updateCountLabel();
  }

  private replaceCurrent(): void {
    if (this.deps.getMode() === 'reading' || !this.input || !this.replaceInput) return;
    if (this.count === 0) return;
    if (this.activeIndex < 0) this.next();
    if (this.activeIndex < 0 || this.count === 0) return;
    const replacement = this.replaceInput.value;
    let ok = false;
    if (this.deps.getMode() === 'source') {
      const src = this.deps.getSource();
      ok = src ? cmReplaceMatch(src.view, this.activeIndex, replacement) : false;
    } else {
      ok = this.deps.visual.searchReplace(this.activeIndex, replacement);
    }
    if (!ok) return;
    this.deps.onEdited();
    this.refreshCount();
    // walk to the next match — also breaks the "a"→"aa" loop, where the
    // replacement itself matches the query and the same spot would be
    // replaced forever
    if (this.count > 0) this.next();
    this.updateCountLabel();
  }

  private replaceAll(): void {
    if (this.deps.getMode() === 'reading' || !this.replaceInput) return;
    if (this.count === 0) return;
    const replacement = this.replaceInput.value;
    let replaced = 0;
    if (this.deps.getMode() === 'source') {
      const src = this.deps.getSource();
      replaced = src ? cmReplaceAllMatches(src.view, replacement) : 0;
    } else {
      replaced = this.deps.visual.searchReplaceAll(replacement);
    }
    if (replaced > 0) this.deps.onEdited();
    this.activeIndex = -1;
    this.refreshCount();
    this.updateCountLabel();
  }
}

// ---------- tiny DOM helpers (Lucide-style strokes like the toolbar) ----------

function iconButton(id: string, className: string, svg: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = id;
  btn.type = 'button';
  btn.className = className;
  btn.innerHTML = svg;
  return btn;
}

const chevronUpSvg =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const chevronDownSvg =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const closeSvg =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
