import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { commandsCtx, remarkStringifyOptionsCtx, schemaCtx, SchemaReady } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { NodeType } from '@milkdown/kit/prose/model';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import {
  createCodeBlockCommand,
  turnIntoTextCommand,
  wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark';
// the link-tooltip component's command (opens the input tooltip) — NOT the
// commonmark preset's `toggleLinkCommand`, which is a parameterized
// toggleMark(link, payload) and throws without an href payload
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip';
import { $shortcut, replaceAll } from '@milkdown/kit/utils';
import { crepeLocaleConfigs } from './crepe-locale';
import { ContextPanel, type PanelClipboardActions } from './context-panel';
import {
  applyVisualBlock,
  toggleVisualMark,
  visualUndoRedo,
  visualSelectAll,
  visualSelectionText,
  visualDeleteSelection,
  visualInsertMarkdown,
  visualCurrentBlock,
  visualDeleteBlock,
  visualToggleTask,
  visualClearFormatting,
  type BlockId,
  type MarkId,
} from './actions';
import { getLang } from '../i18n';

/**
 * Theme for the CodeMirror editor inside code blocks (Crepe's `code-mirror`
 * feature). All colors go through the CSS variables of styles.css, so both
 * themes (and live theme switching) restyle the code without rebuilding this
 * extension.
 *
 * Crepe does NOT replace its default here — it merges `featureConfigs` with
 * the defaults through lodash `defaultsDeep` (crepe.ts), which recurses into
 * arrays and fills missing indexes from the default value (oneDark). The
 * theme entry is therefore kept shape-identical to oneDark's: oneDark's
 * `EditorView.theme(..., {dark: true})` yields a 3-element array whose last
 * element is `EditorView.darkTheme.of(true)`; without our own third element
 * that dark flag leaks in and forces CodeMirror's dark base theme (dark
 * fallback chrome — e.g. the Ctrl+F search panel — in the light app theme).
 * `EditorView.darkTheme.of(false)` occupies that slot instead: the base is
 * light, which is correct for both app themes since our palette never relies
 * on CodeMirror's dark base rules. The panel chrome Crepe does not reskin
 * through its token layer is pinned to variables in the theme below.
 */
const codeBlockTheme: Extension = [
  [
    // spread: the theme entry must stay a flat 3-element array to mirror
    // oneDark's [themeClass, styleModule, darkTheme] shape (see above)
    ...(EditorView.theme({
      '&': { color: 'var(--fg)', backgroundColor: 'transparent' },
      '.cm-content': { caretColor: 'var(--accent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--sel)' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-3)', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 3.5%, transparent)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '&.cm-focused .cm-matchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
        outline: 'none',
      },
      '.cm-tooltip': {
        border: '1px solid var(--border)',
        backgroundColor: 'var(--bg-raised)',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--sel)',
      },
      // The search panel (Ctrl+F from basicSetup) is reskinned by Crepe's
      // code-mirror.css through its token layer (mapped to the variables of
      // styles.css there) — panel, inputs and buttons all follow the app
      // theme. Only the base-theme hairlines Crepe leaves untouched are
      // pinned to variables here; with the light base below they would
      // otherwise stay fixed #ddd/#silver in the dark theme. Same
      // generated-class specificity as the base rules, but mounted later,
      // so these win.
      '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
      '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
      '.cm-textfield': { border: '1px solid var(--border-strong)' },
    }) as Extension[]),
    // the third element oneDark fills with darkTheme.of(true) — keeps the
    // shapes aligned so defaultsDeep cannot refill it (see header comment)
    EditorView.darkTheme.of(false),
  ],
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: 'var(--syn-key)' },
      { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-str)' },
      { tag: [t.number, t.bool, t.atom], color: 'var(--syn-num)' },
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-com)', fontStyle: 'italic' },
      { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-num)' },
      { tag: t.function(t.variableName), color: 'var(--syn-key)' },
      { tag: t.variableName, color: 'var(--fg)' },
      { tag: t.propertyName, color: 'var(--fg-2)' },
      { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--fg-2)' },
      { tag: t.meta, color: 'var(--fg-2)' },
      { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
      { tag: t.strong, fontWeight: '700' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
    ]),
  ),
  // Ctrl+/ is the app-wide mode toggle (main.ts window handler). basicSetup
  // binds Mod-/ to toggleComment inside code blocks, so a caret there used
  // to BOTH flip the mode and inject a line comment into the code — the
  // same double-fire the source editor swallows (source.ts). Swallow it
  // here too; the window handler still performs the flip.
  Prec.high(keymap.of([{ key: 'Mod-/', run: () => true }])),
];

/**
 * #33 (lossless round-trip): a plain `| - |` table column is `null`-aligned
 * in mdast, but three stock layers each coerce that null into an explicit
 * `'left'`, and the file then saves as `| :- |` — an alignment it never
 * declared:
 *
 *  1. the gfm cell schema defaults the `alignment` attr to `'left'`;
 *  2. `toDOM` writes `style="text-align: left"` for a null cell
 *     (`value || 'left'`);
 *  3. the milkdown clipboard plugin round-trips every plain-text paste
 *     through PM → DOM → PM, and the DOM parse rule reads that fabricated
 *     style back as an explicit `'left'`.
 *
 * Patching the node specs at registration time cannot work — Crepe's gfm
 * registrations land after any `use()`d plugin's sync phase — so this runs
 * right after SchemaReady and adjusts the built NodeTypes directly: a null
 * default, a DOM render that skips the style for unaligned cells, and a DOM
 * parse that keeps `'left'` only when the markup carries a real
 * `text-align`. Milkdown builds its paste-side DOM parsers/serializers per
 * event, so the patched specs are picked up live.
 */
const tableAlignmentFix: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(SchemaReady);
    const schema = ctx.get(schemaCtx);
    for (const name of ['table_header', 'table_cell'] as const) {
      const type = schema.nodes[name] as
        | (NodeType & { attrs: Record<string, { default: unknown }> })
        | undefined;
      if (!type) continue;

      type.attrs.alignment.default = null;

      const origToDOM = type.spec.toDOM;
      if (origToDOM) {
        type.spec.toDOM = (node) => {
          const spec = origToDOM(node) as [string, Record<string, unknown>, ...unknown[]];
          if (node.attrs.alignment == null && spec?.[1]?.style) delete spec[1].style;
          return spec;
        };
      }

      type.spec.parseDOM = type.spec.parseDOM?.map((rule) => ({
        ...rule,
        getAttrs: (dom: HTMLElement) => {
          const base = rule.getAttrs ? rule.getAttrs(dom) : null;
          if (!base || typeof base !== 'object') return base ?? null;
          if (base.alignment === 'left' && !dom.style?.textAlign) {
            return { ...base, alignment: null };
          }
          return base;
        },
      }));
    }
  };
};

/**
 * Visual mode: Milkdown (Crepe) — live WYSIWYG rendering of the whole document.
 * Source-on-focus (Typora-style raw markdown under the cursor) is a roadmap
 * goal, not implemented yet — stock Crepe never reveals the raw markup.
 */
export class VisualEditor {
  private crepe: Crepe | null = null;
  private root: HTMLElement | null = null;
  private onChange: (() => void) | null = null;
  private panel: ContextPanel | null = null;
  private panelClipboard: PanelClipboardActions | null = null;

  // The link-edit tooltip's own Escape handler sits on its <input> (and stops
  // propagation there), but after Ctrl+K the focus can remain in the editor —
  // there Escape dies and the tooltip stays open. Catch it before the editor
  // and route it into the input, so the component's own cancel path runs
  // (hides the tooltip, resets state, drops the outside-click listener).
  // The re-dispatch must be deferred: a keydown dispatched synchronously
  // inside another keydown's listener never reaches the input's own handlers
  // (observed in Chromium/WebView2 — the nested event dies in the capture
  // phase), while a timeout-scheduled one dispatches cleanly.
  private escapeLinkTooltip = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const tooltip = this.root?.querySelector('.milkdown-link-edit[data-show="true"]');
    if (!tooltip || tooltip.contains(document.activeElement)) return;
    const input = tooltip.querySelector('input');
    if (!input) return;
    e.preventDefault();
    e.stopPropagation();
    window.setTimeout(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
  };

  constructor() {
    // Block moving left the core (#15): Crepe re-creates the handle widget
    // on every full document replace (file open), re-arming draggable=true
    // on a fresh element — a per-element strip cannot survive that. One
    // capture-phase listener kills every drag session the handle starts,
    // no matter how often the widget is rebuilt. The grip icon is hidden
    // via CSS for the same reason (styles.css).
    //
    // stopPropagation matters as much as preventDefault: plugin-block binds
    // its own dragstart on the element, which sets view.dragging — and a
    // canceled session never receives the dragend that clears it, leaving
    // stale state for the next (legitimate) drop to trip over.
    document.addEventListener(
      'dragstart',
      (e) => {
        if (e.target instanceof Element && e.target.closest('.milkdown-block-handle')) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  async create(
    root: HTMLElement,
    defaultValue: string,
    onChange: () => void,
    panelClipboard?: PanelClipboardActions,
  ): Promise<void> {
    this.root = root;
    this.onChange = onChange;
    // re-registering on rebuild (language switch) is a no-op for the extra
    // listener: remove first, then add
    document.removeEventListener('keydown', this.escapeLinkTooltip, true);
    document.addEventListener('keydown', this.escapeLinkTooltip, true);
    // carried across rebuilds (language switch re-creates the panel too)
    if (panelClipboard) this.panelClipboard = panelClipboard;
    // a rebuild (language switch) remounts everything — clean the old panel first
    this.panel?.destroy();
    const locale = crepeLocaleConfigs(getLang());
    this.crepe = new Crepe({
      root,
      defaultValue,
      // the app-level empty-state hint replaces Crepe's block placeholder;
      // the right-click context panel (see below) replaces the auto
      // selection toolbar — a panel on every selection is noise while
      // copying text or sharing the screen (owner decision 2026-10-03)
      features: { placeholder: false, toolbar: false },
      // merged with Crepe's defaults (defaultsDeep), not replaced — see
      // the codeBlockTheme note on why the shapes must stay aligned
      featureConfigs: {
        ...locale,
        [Crepe.Feature.CodeMirror]: {
          ...locale[Crepe.Feature.CodeMirror],
          theme: codeBlockTheme,
        },
      },
    });
    // Typora-style aliases on top of the built-in Ctrl+Alt-… keymap of
    // the commonmark preset (Ctrl+Alt+1..6/0 already work out of the box):
    // Ctrl+1..6 → heading level, Ctrl+0 → plain text — familiar muscle
    // memory for the Typora audience ProsaMD targets.
    //
    // 'Mod-Alt-с' mirrors the preset's Ctrl+Alt+C (code block) for the RU
    // layout: prosemirror-keymap matches e.key, and its physical-keyCode
    // fallback — which normally rescues letter combos on non-Latin layouts
    // (Ctrl+B/I/E, Ctrl+Shift+B) — is explicitly skipped for Ctrl+Alt on
    // Windows, because Ctrl+Alt doubles as AltGr there. Without this alias
    // the code-block hotkey is dead on the RU layout (same bug class as
    // the fixed Ctrl+O in main.ts). Digits are layout-identical; the alias
    // itself never fires on the EN layout.
    this.crepe.editor.use(
      $shortcut((ctx) => {
        const call = ctx.get(commandsCtx);
        return {
          'Mod-0': () => call.call(turnIntoTextCommand.key),
          'Mod-1': () => call.call(wrapInHeadingCommand.key, 1),
          'Mod-2': () => call.call(wrapInHeadingCommand.key, 2),
          'Mod-3': () => call.call(wrapInHeadingCommand.key, 3),
          'Mod-4': () => call.call(wrapInHeadingCommand.key, 4),
          'Mod-5': () => call.call(wrapInHeadingCommand.key, 5),
          'Mod-6': () => call.call(wrapInHeadingCommand.key, 6),
          'Mod-Alt-с': () => call.call(createCodeBlockCommand.key),
          // Typora parity: Ctrl+K toggles a link on the selection (the
          // letter-key physical-keyCode fallback covers non-Latin layouts)
          'Mod-k': () => call.call(toggleLinkCommand.key),
        };
      }),
    );
    // `bullet: '-'` keeps `-`-marked lists byte-identical on save (the
    // serializer default is `*`, which flips every dash marker); a sibling
    // list written with `*` still serializes as `*` — the serializer picks
    // the "other" bullet for adjacent lists so they cannot merge
    this.crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: '-' as const }));
    });
    this.crepe.editor.use(tableAlignmentFix);
    // only real document changes count as edits: a DOM-wide mutation observer
    // would misread focus/cursor/block-handle widget mutations as edits
    this.crepe.editor.use(listener);
    await this.crepe.create();
    this.crepe.editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated(() => onChange());
    });
    // the right-click formatting panel — the only floating panel left
    this.panel = new ContextPanel();
    this.panel.mount(this.crepe, root, this.panelClipboard ?? undefined);
  }

  getMarkdown(): string {
    return this.crepe?.getMarkdown() ?? '';
  }

  /**
   * Recreate the editor with fresh feature configs. Crepe bakes its
   * configs (including the localized strings from crepe-locale) in at
   * construction, so a language switch needs a full rebuild — there is no
   * supported way to re-localize a live instance. Undo history is lost;
   * language toggles are rare enough to accept that. Content and the
   * change callback are carried over from the destroyed instance.
   */
  async rebuild(defaultValue: string): Promise<void> {
    if (!this.root) return;
    const onChange = this.onChange;
    await this.crepe?.destroy();
    // destroy unmounts the ProseMirror DOM; clear any leftovers so the
    // new instance mounts into a clean root
    this.root.replaceChildren();
    if (onChange) await this.create(this.root, defaultValue, onChange);
  }

  setMarkdown(md: string): void {
    if (!this.crepe) return;
    this.crepe.editor.action(replaceAll(md, true));
  }

  focus(): void {
    const el = this.root?.querySelector('.ProseMirror');
    if (el instanceof HTMLElement) el.focus();
  }

  // ---------- command surface for the menu bar (#20) ----------
  // Thin pass-throughs to ./actions so callers (menu, hotkeys) never touch
  // the crepe instance directly; no-ops before the first create().

  applyBlock(id: BlockId): void {
    if (this.crepe) applyVisualBlock(this.crepe, id);
  }

  toggleMark(id: MarkId): void {
    if (this.crepe) toggleVisualMark(this.crepe, id);
  }

  undoRedo(which: 'undo' | 'redo'): void {
    if (this.crepe) visualUndoRedo(this.crepe, which);
  }

  selectAll(): void {
    if (this.crepe) visualSelectAll(this.crepe);
  }

  selectionText(): string {
    return this.crepe ? visualSelectionText(this.crepe) : '';
  }

  deleteSelection(): void {
    if (this.crepe) visualDeleteSelection(this.crepe);
  }

  insertMarkdown(md: string): void {
    if (this.crepe) visualInsertMarkdown(this.crepe, md);
  }

  // ---------- line-level commands for the #35 hotkey aliases ----------

  deleteBlock(): void {
    if (this.crepe) visualDeleteBlock(this.crepe);
  }

  toggleTask(): void {
    if (this.crepe) visualToggleTask(this.crepe);
  }

  clearFormatting(): void {
    if (this.crepe) visualClearFormatting(this.crepe);
  }

  currentBlock(): BlockId | null {
    return this.crepe ? visualCurrentBlock(this.crepe) : null;
  }
}
