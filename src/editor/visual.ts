import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { replaceAll } from '@milkdown/kit/utils';

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
];

/**
 * Visual mode: Milkdown (Crepe) — live WYSIWYG rendering of the whole document.
 * Source-on-focus (Typora-style raw markdown under the cursor) is a roadmap
 * goal, not implemented yet — stock Crepe never reveals the raw markup.
 */
export class VisualEditor {
  private crepe: Crepe | null = null;
  private root: HTMLElement | null = null;

  async create(root: HTMLElement, defaultValue: string, onChange: () => void): Promise<void> {
    this.root = root;
    this.crepe = new Crepe({
      root,
      defaultValue,
      // the app-level empty-state hint replaces Crepe's block placeholder
      features: { placeholder: false },
      // merged with Crepe's defaults (defaultsDeep), not replaced — see
      // the codeBlockTheme note on why the shapes must stay aligned
      featureConfigs: {
        [Crepe.Feature.CodeMirror]: { theme: codeBlockTheme },
      },
    });
    // only real document changes count as edits: a DOM-wide mutation observer
    // would misread focus/cursor/block-handle widget mutations as edits
    this.crepe.editor.use(listener);
    await this.crepe.create();
    this.crepe.editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated(() => onChange());

      // Block moving is out of the core (owner decision 2026-10-03, #15):
      // the ideal drag UX needs many deliberate decisions and is plugin
      // territory, not core. Kill the drag affordance but keep the
      // add-block button: strip `draggable` (no drag session can start) and
      // hide the grip icon, which would otherwise advertise dragging. The
      // handle is a floating overlay appended to document.body — not part of
      // the editor root — and may mount a tick after create().
      const stripDrag = (): boolean => {
        const handle = document.querySelector('.milkdown-block-handle');
        if (!(handle instanceof HTMLElement)) return false;
        handle.removeAttribute('draggable');
        handle.addEventListener('dragstart', (e) => e.preventDefault());
        const items = handle.querySelectorAll('.operation-item');
        const grip = items[items.length - 1];
        if (grip instanceof HTMLElement) grip.style.display = 'none';
        return true;
      };
      if (!stripDrag()) requestAnimationFrame(stripDrag);
    });
  }

  getMarkdown(): string {
    return this.crepe?.getMarkdown() ?? '';
  }

  setMarkdown(md: string): void {
    if (!this.crepe) return;
    this.crepe.editor.action(replaceAll(md, true));
  }

  focus(): void {
    const el = this.root?.querySelector('.ProseMirror');
    if (el instanceof HTMLElement) el.focus();
  }
}
