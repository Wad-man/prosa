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
import { openSearchPanel } from '@codemirror/search';
import { cmApplySearch, cmGoToMatch, cmMatchCount, cmMatchFrom, cmReplaceAllMatches, cmReplaceMatch } from './editor/cm-search';

export interface FindReplaceDeps {
  visual: VisualEditor;
  getSource: () => SourceEditor | null;
  getMode: () => 'reading' | 'visual' | 'source' | 'split';
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
  private closeBtn: HTMLButtonElement | null = null;
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
    // Esc lives in the BUBBLE phase: editor UI that owns Esc (slash menu,
    // block menu, code-language picker, CM autocomplete, the link tooltip)
    // handles the key on its own element first and calls preventDefault —
    // by the time the event bubbles here it is already claimed, and the bar
    // must not steal it (review MINOR-8)
    window.addEventListener('keydown', (e) => this.onEscape(e), false);
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

  /** Правка → Найти… / Ctrl+F; `withReplace` shows the replace row
   * (Ctrl+H). In the SOURCE mode both route to CodeMirror's own search
   * panel instead — its advanced toolset (regexp, word, per-hit buttons)
   * is the right tool there (owner decision, post-RC2). Ctrl+H focuses
   * the panel's replace field (CM's keymap has no Mod-h binding). */
  open(withReplace: boolean): void {
    if (this.deps.isOverlayOpen()) return;
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
      const src = this.deps.getSource();
      if (src) {
        openSearchPanel(src.view);
        if (withReplace) {
          const replace = src.view.dom.querySelector<HTMLInputElement>(
            '.cm-panel.cm-search input[name=replace]',
          );
          replace?.focus();
        }
      }
      return;
    }
    this.ensureBuilt();
    // per-invocation, not sticky: Ctrl+F is find-only, Ctrl+H brings the
    // replace row — a previous Ctrl+H must not leak into the next Ctrl+F
    this.replaceVisible = withReplace;
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
    // entering the source mode hands search over to CodeMirror's panel —
    // the bar has no business there (owner decision, post-RC2)
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
      this.close();
      return;
    }
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
    // #119: the close cross is an icon button — it needs the accessible
    // name every other icon button here already carries
    this.closeBtn!.title = t('closeTip');
    this.closeBtn!.setAttribute('aria-label', t('closeTip'));
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
      // source mode: the app opens CM's own panel itself — CM's keymap
      // only sees Mod-f, and only when its editor holds focus (menu open,
      // chrome focused → nothing would fire at all, review MINOR-7)
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
    }
  }

  /** Bubble-phase Esc: see the constructor comment. */
  private onEscape(e: KeyboardEvent): void {
    if (!this.isOpen || e.isComposing) return;
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.defaultPrevented) return; // someone inside the editor already used it
    if (this.deps.isOverlayOpen()) return; // the modal wins its own Esc
    // the bar closes on Esc while IT holds focus or while the caret sits
    // in one of the editor panes (the owner's "clicked into the text and
    // pressed Esc" case). Elsewhere (menus, tooltips, chrome) Esc stays
    // with whoever owns it.
    const active = document.activeElement;
    const inBar = active !== null && this.bar !== null && this.bar.contains(active);
    const inPanes =
      active instanceof Element && active.closest('#visual-editor, #source-editor') !== null;
    if (!inBar && !inPanes) return;
    if (document.querySelector('.milkdown-link-edit[data-show="true"]')) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
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
    // a pictogram reads without translation — same trick as the #70 mouse
    // glyph; the title/aria-label carry the localized meaning
    caseBtn.textContent = 'Aa';
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
    this.closeBtn = closeBtn;

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
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
      const src = this.deps.getSource();
      this.count = src ? cmApplySearch(src.view, query, this.caseSensitive, this.activeIndex) : 0;
    } else {
      this.deps.visual.setSearch(query, this.caseSensitive);
      this.count = this.deps.visual.searchMatchCount();
    }
    this.updateCountLabel();
  }

  private refreshCount(): void {
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
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
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
      const src = this.deps.getSource();
      if (src) cmGoToMatch(src.view, index);
    } else {
      this.deps.visual.setSearchActive(index);
    }
    this.updateCountLabel();
  }

  /** Position of match `index` in the active pane (-1 when out of range). */
  private matchFrom(index: number): number {
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
      const src = this.deps.getSource();
      return src ? (cmMatchFrom(src.view, index) ?? -1) : -1;
    }
    return this.deps.visual.searchMatchFrom(index);
  }

  private replaceCurrent(): void {
    if (this.deps.getMode() === 'reading' || !this.input || !this.replaceInput) return;
    if (this.count === 0) return;
    if (this.activeIndex < 0) this.next();
    if (this.activeIndex < 0 || this.count === 0) return;
    const replacement = this.replaceInput.value;
    // where the replaced match started — the walk after the replace must
    // land PAST the insertion, or "a"→"aa" would re-find its own output
    const replacedFrom = this.matchFrom(this.activeIndex);
    let ok = false;
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
      const src = this.deps.getSource();
      ok = src ? cmReplaceMatch(src.view, this.activeIndex, replacement) : false;
    } else {
      ok = this.deps.visual.searchReplace(this.activeIndex, replacement);
    }
    if (!ok) return;
    this.deps.onEdited();
    this.refreshCount();
    // the next match to offer: the first one starting at/after the end of
    // the inserted text (indices alone lie — the list shifts on the edit);
    // wraps to the first match when the document ends before that
    const past = replacedFrom + replacement.length;
    if (this.count > 0) {
      let target = -1;
      for (let i = 0; i < this.count; i++) {
        if (this.matchFrom(i) >= past) {
          target = i;
          break;
        }
      }
      this.goTo(target === -1 ? 0 : target);
    }
    this.updateCountLabel();
  }

  private replaceAll(): void {
    if (this.deps.getMode() === 'reading' || !this.replaceInput) return;
    if (this.count === 0) return;
    const replacement = this.replaceInput.value;
    let replaced = 0;
    if (this.deps.getMode() === 'source' || this.deps.getMode() === 'split') {
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
