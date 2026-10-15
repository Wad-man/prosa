import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './i18n';
import { cssZoom } from './zoom';
import { sourceHeadings } from './editor/md-source';

/** The column ladder (styles.css reads these back as --toc-col/--toc-left):
 *  a wide margin hosts the full 220px column at a 48px gap, a tighter one
 *  the 180px tier, anything narrower turns the panel into a right-anchored
 *  overlay drawer (the prototype's ≤820 pattern). */
const COL_WIDE = 220;
const COL_NARROW = 180;
const GAP_WIDE = 48;
const GAP_NARROW = 32;

/**
 * Document outline (#21): the first core capability gated by a feature flag
 * (src/features.ts). A right-hand page column inside #editor-panes, sibling
 * of the editor panes wrapper — shown via Вид → Оглавление / Ctrl+Shift+1,
 * hidden by default like Typora's collapsed sidebar. The column hugs the
 * text (owner audit 2026-10-15): its slot is measured from the live
 * content column, the text itself never moves.
 *
 * Heading sources are mode-native: the live DOM in visual mode (element
 * anchors survive Crepe rebuilds because they are re-queried per refresh),
 * the document text in source mode (ATX scan that skips fenced code).
 */

export interface TocSourceEditor {
  view: EditorView;
  getContent(): string;
  focus(): void;
}

export interface TocContext {
  /** The live mode collapsed to the pane that renders it: reading → 'visual'
   *  (same render), split stays 'split' — the #91 gate (2026-10-15, вариант
   *  А) makes split code-first: entries come from the ATX scan, navigation
   *  drives the code pane with the preview softly following. */
  getMode(): 'visual' | 'source' | 'split';
  getVisualPane(): HTMLElement | null;
  getSource(): TocSourceEditor | null;
}

interface TocEntry {
  level: number;
  text: string;
  el?: Element;
  line?: number; // source mode, 1-based
}

export class TocPanel {
  private ctx: TocContext | null = null;
  private host: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private entries: TocEntry[] = [];
  private activeIndex = -1;
  private flashTimer: number | undefined;
  // #36: [hidden] lands only after the close transition finished
  private closeTimer: number | undefined;
  private resizeObserver: ResizeObserver | null = null;
  /** navigate() parks the active item on its target; viewport-top tracking
   *  must not steal it back while the programmatic scroll settles (product
   *  audit D2 — in source mode the centered jump made the outline highlight
   *  the heading above the one the user clicked). */
  private navHoldUntil = 0;
  // #30: skip button rebuilds when the headings did not change — mode
  // switches used to recreate every .toc-item (and its listeners) for nothing.
  // #50: starts at null — '' is the legitimate signature of a heading-less
  // document and must not collide with "never rendered yet" (the fresh
  // empty document skipped its placeholder on exactly that collision)
  private renderedSig: string | null = null;

  mount(host: HTMLElement, ctx: TocContext): void {
    this.ctx = ctx;
    this.host = host;

    const panel = document.createElement('aside');
    panel.id = 'toc-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', t('tocTitle'));

    // #91 → owner audit 2026-10-15: the panel is a clip WINDOW at the hug
    // position; the whole column flies inside it (translateX), so it slides
    // out from under the text's right edge without any z-order painting
    const fly = document.createElement('div');
    fly.className = 'toc-fly';

    // #91: a quiet page-part caption instead of the old sidebar header
    const cap = document.createElement('div');
    cap.className = 'toc-cap';
    cap.textContent = t('tocOnPage');

    this.list = document.createElement('nav');
    this.list.className = 'toc-list';
    this.list.setAttribute('role', 'navigation');

    fly.append(cap, this.list);
    panel.append(fly);
    // #91: right column, after the text in DOM so Tab reaches the document
    // first and screen readers announce text before navigation
    host.append(panel);
    this.panel = panel;

    // the hug position depends on the live content column — re-measure on
    // every pane resize (window resizes, zoom steps, pane flips in split)
    this.resizeObserver = new ResizeObserver(() => this.remeasure());
    this.resizeObserver.observe(host);
  }

  relabel(): void {
    if (!this.panel) return;
    this.panel.setAttribute('aria-label', t('tocTitle'));
    const cap = this.panel.querySelector('.toc-cap');
    if (cap) cap.textContent = t('tocOnPage');
    this.render(); // placeholder text is localized too
  }

  /** Show/hide the outline column (#91 → rc.7 rerun): the column slides out
   *  from under the text's right edge and slides back under it (owner
   *  audit 2026-10-15 — the flight is horizontal, the outer panel clips
   *  it, compositor-only). `hidden` lands only after the close transition
   *  finished; `inert` drops the closing panel from the tab order at once. */
  setVisible(visible: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    const open = panel.classList.contains('is-open');
    if (visible === open) return;
    window.clearTimeout(this.closeTimer);
    if (visible) {
      this.remeasure();
      panel.hidden = false;
      panel.inert = false;
      // reflow so the flight plays from the parked state, not from display:none
      void panel.offsetWidth;
      panel.classList.add('is-open');
      this.host?.classList.add('toc-open');
    } else {
      panel.classList.remove('is-open');
      this.host?.classList.remove('toc-open');
      panel.inert = true;
      this.closeTimer = window.setTimeout(() => {
        if (!panel.classList.contains('is-open')) panel.hidden = true;
      }, 260);
    }
  }

  isVisible(): boolean {
    const panel = this.panel;
    return panel !== null && panel.classList.contains('is-open');
  }

  /** Write a custom property only when the value actually changed — a
   *  same-value setProperty still invalidates the subtree's inherited
   *  styles, and remeasure() runs on every refresh()/resize tick (review:
   *  needless style recalc of the whole document while typing). */
  private static setVar(el: HTMLElement | null, name: string, value: string): void {
    if (!el || el.style.getPropertyValue(name) === value) return;
    el.style.setProperty(name, value);
  }

  /** Re-measure the outline's geometry (owner audit 2026-10-15): the column
   *  hugs the TEXT like the prototype's aside — parked in the live margin
   *  right of the content column — while the scrollers stay full-width (the
   *  scrollbar keeps its window-edge seat, the text never rewraps). Sets
   *  --toc-left/--toc-col/--sb on the panel; when the margin cannot host
   *  the column the panel degrades to a right-anchored .toc-overlay drawer.
   *  Also feeds --toc-fr (the find bar keeps clear of the open column).
   *  Main.ts calls this on mode switches, loads and resizes; the
   *  ResizeObserver covers the rest. */
  remeasure(): void {
    const host = this.host;
    const panel = this.panel;
    if (!host || !panel) return;

    const scrollers: (Element | null)[] = [
      document.getElementById('visual-editor'),
      this.ctx?.getSource()?.view.scrollDOM ?? null,
    ];
    let sb = 0;
    for (const el of scrollers) {
      if (el instanceof HTMLElement) sb = Math.max(sb, el.offsetWidth - el.clientWidth);
    }
    sb = Math.max(0, sb);
    TocPanel.setVar(panel, '--sb', `${sb}px`);

    // the find bar lives one level up (#editor-host) and inherits nothing
    // from the panes — hand it its clearance var explicitly
    const findHost = host.parentElement;

    // hug target: the right edge of the widest VISIBLE content column (in
    // split the preview pane is the right-hand one and wins on its own)
    const z = cssZoom();
    const hostRect = host.getBoundingClientRect();
    let contentRight = -Infinity;
    for (const el of document.querySelectorAll(
      '#visual-editor .ProseMirror, #source-editor .cm-content',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) contentRight = Math.max(contentRight, r.right);
    }

    if (contentRight === -Infinity) {
      // no live column yet (boot / pending file): park at the window edge
      // rather than in a stale measured position
      this.applyOverlayTier(panel, findHost, sb, z);
      return;
    }

    // live margin till the SCROLLBAR (review: without -sb the column could
    // sit on the bar — left+width make the right anchor ignored)
    const freeCss = (hostRect.right - contentRight) / z - sb;
    if (freeCss >= COL_WIDE + GAP_WIDE + 24) {
      TocPanel.setVar(panel, '--toc-col', `${COL_WIDE}px`);
      TocPanel.setVar(
        panel,
        '--toc-left',
        `${Math.round((contentRight - hostRect.left) / z + GAP_WIDE)}px`,
      );
      panel.classList.remove('toc-overlay');
      // the shift is measured from the host's box edge (scrollbar included),
      // so sb goes back in — freeCss alone would eat it (review round 2)
      this.placeFindBar(findHost, freeCss - GAP_WIDE - COL_WIDE, freeCss + sb - GAP_WIDE + 20);
    } else if (freeCss >= COL_NARROW + GAP_NARROW + 16) {
      TocPanel.setVar(panel, '--toc-col', `${COL_NARROW}px`);
      TocPanel.setVar(
        panel,
        '--toc-left',
        `${Math.round((contentRight - hostRect.left) / z + GAP_NARROW)}px`,
      );
      panel.classList.remove('toc-overlay');
      this.placeFindBar(findHost, freeCss - GAP_NARROW - COL_NARROW, freeCss + sb - GAP_NARROW + 20);
    } else {
      this.applyOverlayTier(panel, findHost, sb, z);
    }
  }

  /** The find bar: when the space RIGHT of the column hosts the whole bar
   *  it stays at the window edge (16px); otherwise it shifts 20px left of
   *  the column (review: on very wide windows the shift parked it mid-
   *  screen over the text). */
  private placeFindBar(
    findHost: HTMLElement | null,
    roomRightOfColumn: number,
    shiftFromEdge: number,
  ): void {
    const FR_SAFE = 500; // a generous find-bar budget (bar + margins)
    TocPanel.setVar(
      findHost,
      '--toc-fr',
      `${roomRightOfColumn >= FR_SAFE ? 16 : Math.max(16, Math.round(shiftFromEdge))}px`,
    );
  }

  /** The fallback tier: a right-anchored drawer over the text with its own
   *  surface (the prototype's ≤820 pattern). */
  private applyOverlayTier(
    panel: HTMLElement,
    findHost: HTMLElement | null,
    sb: number,
    z: number,
  ): void {
    if (panel.style.getPropertyValue('--toc-left')) panel.style.removeProperty('--toc-left');
    TocPanel.setVar(panel, '--toc-col', 'min(240px, 72vw)');
    panel.classList.add('toc-overlay');
    // prefer the real laid-out width (vw under html zoom is engine-flavored);
    // a closed panel measures 0 — fall back to the formula
    const laidOut = panel.getBoundingClientRect().width / z;
    const col = laidOut > 0 ? laidOut : Math.min(240, Math.round((0.72 * window.innerWidth) / z));
    TocPanel.setVar(findHost, '--toc-fr', `${Math.round(sb + col + 20)}px`);
  }

  /**
   * Live heading elements of the visual mode. ProseMirror re-creates node
   * DOM on full replaces (file open, mode switch) — cached `el` references
   * go stale and detached, so every consumer re-resolves through here
   * instead of trusting the cached entry.
   */
  private visualHeadingEls(): Element[] {
    const pane = this.ctx?.getVisualPane();
    if (!pane) return [];
    return Array.from(
      pane.querySelectorAll(
        '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6',
      ),
    );
  }

  /** Recollect headings from the active mode's native source. */
  refresh(): void {
    // a document landing or growing past the viewport adds a scrollbar the
    // parked column must respect (QA: startup on an empty doc measures
    // --sb = 0 and never re-measured on paste/file-open — the panel then
    // sat on the document scrollbar until reopened)
    this.remeasure();
    this.entries = [];
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.getMode() === 'visual') {
      for (const el of this.visualHeadingEls()) {
        this.entries.push({
          level: Number(el.tagName.slice(1)),
          text: (el.textContent ?? '').trim(),
          el,
        });
      }
    } else {
      const source = ctx.getSource();
      if (source) {
        for (const h of sourceHeadings(source.getContent())) {
          this.entries.push({ level: h.level, text: h.text, line: h.line });
        }
      }
    }
    this.activeIndex = -1;
    this.render();
    this.updateActive();
  }

  private render(): void {
    if (!this.list) return;
    // same headings as the last render — the buttons (and their listeners)
    // stay; only the active highlight may still change (#30)
    const sig = this.entries.map((e) => `${e.level}|${e.text}`).join('\n');
    if (sig === this.renderedSig) return;
    this.renderedSig = sig;
    this.list.replaceChildren();
    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'toc-empty';
      empty.textContent = t('tocEmpty');
      this.list.append(empty);
      return;
    }
    this.entries.forEach((entry, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'toc-item';
      item.style.setProperty('--lvl', String(entry.level));
      item.textContent = entry.text || '#';
      item.title = entry.text;
      item.addEventListener('pointerdown', (e) => e.preventDefault());
      item.addEventListener('click', () => this.navigate(i));
      this.list?.append(item);
    });
  }

  private navigate(index: number): void {
    const entry = this.entries[index];
    const ctx = this.ctx;
    if (!entry || !ctx) return;
    if (ctx.getMode() === 'visual') {
      // re-resolve: the cached el may be stale after a PM full replace
      const els = this.visualHeadingEls();
      const el = els.length === this.entries.length ? els[index] : entry.el;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.flash(el);
    } else {
      const source = ctx.getSource();
      if (source && entry.line !== undefined) {
        const view = source.view;
        const pos = Math.min(view.state.doc.line(entry.line).from + 1, view.state.doc.length);
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        source.focus();
        // #91 gate (вариант А): a split click is code-first — the preview no
        // longer needs an explicit follow, the panes scroll as one (#62,
        // гейт 2026-10-15): the code jump itself carries the preview along
      }
    }
    this.setActive(index);
    this.navHoldUntil = performance.now() + 700;
  }

  private flash(el: Element | undefined): void {
    if (!(el instanceof HTMLElement)) return;
    window.clearTimeout(this.flashTimer);
    el.classList.remove('toc-flash');
    // restart the animation on repeated clicks
    void el.offsetWidth;
    el.classList.add('toc-flash');
    this.flashTimer = window.setTimeout(() => el.classList.remove('toc-flash'), 1300);
  }

  /** Highlight the heading the viewport is currently in (scroll listener). */
  updateActive(): void {
    if (!this.list || this.entries.length === 0) return;
    const ctx = this.ctx;
    if (!ctx) return;
    if (performance.now() < this.navHoldUntil) return;
    let index = -1;
    if (ctx.getMode() === 'visual') {
      // re-resolve for the same staleness reason as navigate()
      const els = this.visualHeadingEls();
      const useLive = els.length === this.entries.length ? els : this.entries.map((e) => e.el);
      for (let i = 0; i < useLive.length; i++) {
        const el = useLive[i];
        if (el && el.getBoundingClientRect().top <= 140) index = i;
      }
    } else {
      const source = ctx.getSource();
      if (source) {
        const view = source.view;
        // #91 gate: in split the active item follows the caret («where I'm
        // editing» — predictable, already known); pane scroll drifts, and a
        // preview scrolled away for a check must not make the outline lie.
        // Plain source keeps its viewport-top tracking (#21 behavior).
        let line: number;
        if (ctx.getMode() === 'split') {
          line = view.state.doc.lineAt(view.state.selection.main.head).number;
        } else {
          const rect = view.dom.getBoundingClientRect();
          const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 24 });
          if (pos === null) return;
          line = view.state.doc.lineAt(pos).number;
        }
        for (let i = 0; i < this.entries.length; i++) {
          if ((this.entries[i].line ?? Infinity) <= line) index = i;
        }
      }
    }
    this.setActive(index);
  }

  private setActive(index: number): void {
    if (index === this.activeIndex) return;
    this.activeIndex = index;
    if (!this.list) return;
    const items = this.list.querySelectorAll('.toc-item');
    items.forEach((item, i) => item.classList.toggle('active', i === index));
    if (index >= 0) {
      // keep the active item in view when tracking scrolls past it
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }
}
