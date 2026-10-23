import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './i18n';
import { cssZoom } from './zoom';
import { sourceHeadings } from './editor/md-source';

/** The column ladder (styles.css reads these back as --toc-col/--toc-left):
 *  a wide margin hosts the full 220px column at a 48px gap, a tighter one
 *  the 180px tier. Anything narrower — and split, always — gets a RESERVED
 *  column: the text area gives up the column's width and the outline sits
 *  beside it, never over it (owner audit 2026-10-15: the overlay drawer is
 *  gone). */
const COL_WIDE = 220;
const COL_NARROW = 180;
const GAP_WIDE = 48;
const GAP_NARROW = 32;
/** Below this host width the reserved column takes the narrow tier. */
const RESERVE_WIDE_FROM = 1000;

/**
 * Document outline (#21): the first core capability gated by a feature flag
 * (src/features.ts). A right-hand page column inside #editor-panes, sibling
 * of the editor panes wrapper — shown via Вид → Оглавление / Ctrl+Shift+1,
 * hidden by default like Typora's collapsed sidebar. The column hugs the
 * text (owner audit 2026-10-15) when the margin can host it; otherwise
 * (and in split, always) it takes a column of its own beside the text.
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
  /** setVisible() has run once — startup applies the flag without a flight. */
  private shownOnce = false;
  /** the last feature flag setVisible() was asked for */
  private flag = false;

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
   *  from under the text's right edge and back under it — in BOTH tiers
   *  (2026-10-16, #129: the reserve flies the same way; the text yields and
   *  reclaims the strip through the same transition, #133). The outer panel
   *  clips the flight, compositor-only. `hidden` lands only after the close
   *  transition finished; `inert` drops the closing panel from the tab order
   *  at once. #141 (2026-10-24) reverted the #131-1 empty-document
   *  suppression: the toggle must answer on a heading-less document too —
   *  the column shows the «Заголовков нет» placeholder instead. */
  setVisible(visible: boolean): void {
    this.flag = visible;
    this.applyFlag();
  }

  private applyFlag(): void {
    const panel = this.panel;
    if (!panel) return;
    const visible = this.flag;
    const open = panel.classList.contains('is-open');
    if (visible === open) return;
    window.clearTimeout(this.closeTimer);
    if (visible) {
      const first = !this.shownOnce;
      this.shownOnce = true;
      this.remeasure();
      panel.hidden = false;
      panel.inert = false;
      // the window's first frame shows a remembered outline already in
      // place — the flight is for the toggle, not for startup (audit
      // 2026-10-15: the column slid in under the start screen's rise);
      // #133: the host carries the same still so the reserved strip (the
      // text's padding) lands with it instead of creeping in
      if (first) {
        panel.classList.add('toc-still');
        this.host?.classList.add('toc-still');
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            panel.classList.remove('toc-still');
            this.host?.classList.remove('toc-still');
          }),
        );
      }
      // reflow so the flight plays from the parked state, not from display:none
      void panel.offsetWidth;
      panel.classList.add('is-open');
      this.host?.classList.add('toc-open');
    } else {
      panel.classList.remove('is-open');
      panel.inert = true;
      this.closeTimer = window.setTimeout(() => {
        if (panel.classList.contains('is-open')) return;
        // the text reclaims its width only after the column slid back under
        // its edge — on close the two never cross (owner 2026-10-16, #129:
        // the flight reads the same at every width; #133: the reclaim
        // itself transitions, on the same clock as the flight)
        this.host?.classList.remove('toc-open');
        panel.hidden = true;
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

  /** Re-measure the outline's geometry. Two tiers:
   *  - hug (owner audit 2026-10-15): the column is parked in the live margin
   *    right of the content column, the text and scrollbars never move;
   *  - reserve (no room in the margin, and split always): the text area
   *    gives up the column's width (#editor-panes.toc-reserve) and the
   *    outline sits in its own column at the window edge — never over the
   *    text (owner audit 2026-10-15: no overlay mode).
   *  The tier is decided on the CURRENT layout: a reserved text area only
   *  measures a narrower margin than the unreserved one would, so the
   *  decision never flip-flops (it just leaves reserve a touch later).
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
    // split: nothing sits at the window edge (the pair's shared scrollbar
    // lives at the panes' junction, the preview's own bar is hidden) — the
    // reserve strip reaches the edge itself
    const sbEdge = this.ctx?.getMode() === 'split' ? 0 : sb;
    TocPanel.setVar(panel, '--sb', `${sbEdge}px`);

    // the find bar lives one level up (#editor-host) and inherits nothing
    // from the panes — hand it its clearance var explicitly
    const findHost = host.parentElement;
    const z = cssZoom();
    const hostRect = host.getBoundingClientRect();

    if (this.ctx?.getMode() === 'split') {
      // split: the right-hand pane is the preview, its margin is no place
      // for a column — the pair always shares the width with the outline
      this.applyReserveTier(panel, host, findHost, hostRect.width / z, sbEdge);
      return;
    }

    // hug target: the right edge of the widest VISIBLE content column
    let contentRight = -Infinity;
    for (const el of document.querySelectorAll(
      '#visual-editor .ProseMirror, #source-editor .cm-content',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) contentRight = Math.max(contentRight, r.right);
    }

    if (contentRight === -Infinity) {
      // no live column yet (boot / pending file): a reserved column is the
      // tier that needs no measurement
      this.applyReserveTier(panel, host, findHost, hostRect.width / z, sbEdge);
      return;
    }

    // live margin till the SCROLLBAR (review: without -sb the column could
    // sit on the bar — left+width make the right anchor ignored); while
    // reserved, the text area ends where the column starts
    const reserved = host.classList.contains('toc-reserve') && host.classList.contains('toc-open');
    const areaRight = reserved ? hostRect.right - panel.getBoundingClientRect().width : hostRect.right;
    const freeCss = (areaRight - contentRight) / z - sb;
    if (freeCss >= COL_WIDE + GAP_WIDE + 24) {
      this.applyHugTier(panel, host, COL_WIDE, GAP_WIDE, contentRight - hostRect.left, z);
      // the shift is measured from the host's box edge (scrollbar included),
      // so sb goes back in — freeCss alone would eat it (review round 2)
      this.placeFindBar(findHost, freeCss - GAP_WIDE - COL_WIDE, freeCss + sb - GAP_WIDE + 20);
    } else if (freeCss >= COL_NARROW + GAP_NARROW + 16) {
      this.applyHugTier(panel, host, COL_NARROW, GAP_NARROW, contentRight - hostRect.left, z);
      this.placeFindBar(findHost, freeCss - GAP_NARROW - COL_NARROW, freeCss + sb - GAP_NARROW + 20);
    } else {
      this.applyReserveTier(panel, host, findHost, hostRect.width / z, sbEdge);
    }
  }

  private applyHugTier(
    panel: HTMLElement,
    host: HTMLElement,
    col: number,
    gap: number,
    contentRightInHost: number,
    z: number,
  ): void {
    TocPanel.setVar(panel, '--toc-col', `${col}px`);
    TocPanel.setVar(panel, '--toc-left', `${Math.round(contentRightInHost / z + gap)}px`);
    panel.classList.remove('toc-reserve');
    host.classList.remove('toc-reserve');
  }

  /** The reserve tier: the text content gives up --toc-rsv (read by CSS on
   *  the host's scrollers), the outline sits in that strip beside the text —
   *  in single modes left of the window-edge scrollbar (2026-10-16 #129:
   *  the bar keeps its hug-tier seat), in split at the window edge. */
  private applyReserveTier(
    panel: HTMLElement,
    host: HTMLElement,
    findHost: HTMLElement | null,
    hostWidthCss: number,
    sbEdge: number,
  ): void {
    const col = hostWidthCss >= RESERVE_WIDE_FROM ? COL_WIDE : COL_NARROW;
    if (panel.style.getPropertyValue('--toc-left')) panel.style.removeProperty('--toc-left');
    TocPanel.setVar(panel, '--toc-col', `${col}px`);
    TocPanel.setVar(host, '--toc-rsv', `${col}px`);
    panel.classList.add('toc-reserve');
    host.classList.add('toc-reserve');
    // the bar clears the strip and the window-edge scrollbar beside it
    TocPanel.setVar(findHost, '--toc-fr', `${col + sbEdge + 16}px`);
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
      // #126 design-NIT: first-level weight (CSS-only cannot read --lvl)
      item.dataset.lvl = String(entry.level);
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
      // #132: at the scroll end the last heading can stay pinned below the
      // 140px line (the page bottom holds it) — the marker must reach it
      const sc = document.getElementById('visual-editor');
      const maxScroll = sc ? sc.scrollHeight - sc.clientHeight : 0;
      if (sc && maxScroll > 2 && sc.scrollTop >= maxScroll - 2) {
        index = this.entries.length - 1;
      } else {
        for (let i = 0; i < useLive.length; i++) {
          const el = useLive[i];
          if (el && el.getBoundingClientRect().top <= 140) index = i;
        }
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
          // #132: the scroll end must still light the last item — the last
          // heading can be pinned below the viewport-top probe forever
          const sc = view.scrollDOM;
          const maxScroll = sc.scrollHeight - sc.clientHeight;
          if (maxScroll > 2 && sc.scrollTop >= maxScroll - 2) {
            line = Infinity;
          } else {
            const rect = view.dom.getBoundingClientRect();
            const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 24 });
            if (pos === null) return;
            line = view.state.doc.lineAt(pos).number;
          }
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
