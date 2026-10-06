import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { commandsCtx, remarkStringifyOptionsCtx, schemaCtx, SchemaReady, SerializerReady, serializerCtx, editorViewCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { NodeType, Node as ProseNode } from '@milkdown/kit/prose/model';
import { headingIdGenerator } from '@milkdown/kit/preset/commonmark';
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
import { $remark, $shortcut, replaceAll } from '@milkdown/kit/utils';
import { crepeLocaleConfigs } from './crepe-locale';
import { ContextPanel, type PanelClipboardActions } from './context-panel';
import {
  applyVisualBlock,
  toggleVisualMark,
  visualUndoRedo,
  visualSelectAll,
  visualSelectionText,
  visualSelectionMarkdown,
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
 * default (both the live one and NodeType's cached `defaultAttrs`, which
 * `createAndFill()` with no attrs — new tables, added columns — reads),
 * a DOM render that skips the style for unaligned cells, and a DOM parse
 * that keeps `'left'` only when the markup carries a real `text-align`.
 * `DOMParser.fromSchema`/`DOMSerializer.fromSchema` cache on the schema at
 * first use and capture the toDOM reference then, so the patch drops those
 * caches to stay in effect even if something built them earlier.
 */
const tableAlignmentFix: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(SchemaReady);
    const schema = ctx.get(schemaCtx);
    for (const name of ['table_header', 'table_cell'] as const) {
      const type = schema.nodes[name] as
        | (NodeType & {
            attrs: Record<string, { default: unknown }>;
            defaultAttrs: Record<string, unknown> | null;
          })
        | undefined;
      if (!type) continue;

      type.attrs.alignment.default = null;
      if (type.defaultAttrs) {
        type.defaultAttrs = { ...type.defaultAttrs, alignment: null };
      }

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
    // fromSchema() caches its parser/serializer (with the captured toDOM)
    // on the schema at first use — drop whatever may already be there
    delete (schema as unknown as { cached: Record<string, unknown> }).cached
      ?.domParser;
    delete (schema as unknown as { cached: Record<string, unknown> }).cached
      ?.domSerializer;
  };
};

/**
 * #53 (Obsidian/Typora-style line breaks, owner spec 2026-10-06): Enter is a
 * paragraph (a blank line in the file), Shift+Enter is a plain `\n` inside
 * it. Two stock constructs write anything else into the file:
 *
 *  1. the paragraph serializer emits a literal `<br />` html node for an
 *     EMPTY paragraph — the `remark-preserve-empty-line` plugin ships inside
 *     the default `commonmark` array Crepe uses, and the serializer emits
 *     the placeholder whenever that plugin is injected. So an empty line
 *     typed with a double Enter (and the trailing paragraph the trailing
 *     plugin appends after a code block/table) saved as `<br />`;
 *  2. Shift+Enter inserts a hardbreak with `isInline: false`, which
 *     serializes as `\` + newline (a CommonMark hard break).
 *
 * The soft flavor already exists in milkdown 7.22: a hardbreak with
 * `isInline: true` serializes back as a text `\n` — that is how plain `\n`
 * from existing files survives today. This patch runs right after
 * SchemaReady, in the tableAlignmentFix manner:
 *
 *  - flip the `isInline` default, so the stock Shift-Enter command
 *    (`type.create()` with no attrs) produces the soft flavor. Parsed nodes
 *    carry their explicit attrs, so `\`+`\n` from existing files keeps
 *    round-tripping as the hard flavor;
 *  - pin the DOM rule for a PASTED `<br>` tag to the hard flavor. Without
 *    attrs that rule would now inherit the new default, and a soft break
 *    inside a table cell would serialize as a raw newline, splitting the
 *    table row apart; the hard flavor degrades to a space there — the
 *    stock, safe behavior;
 *  - wrap the paragraph serializer: an empty paragraph serializes as an
 *    empty mdast paragraph (a blank line), never as the `<br />`
 *    placeholder. The parse direction stays stock, so files already saved
 *    with `<br />` by earlier builds still open as empty paragraphs.
 *
 * The serializer dispatch reads `spec.toMarkdown` off the live NodeType
 * specs at serialization time, so these spec patches apply to every later
 * save; the DOM-parse cache is dropped because parseDOM rules are captured
 * when DOMParser.fromSchema first builds (same as tableAlignmentFix).
 */
const lineBreaksFix: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(SchemaReady);
    const schema = ctx.get(schemaCtx);

    const hardbreak = schema.nodes.hardbreak as
      | (NodeType & {
          attrs: Record<string, { default: unknown }>;
          defaultAttrs: Record<string, unknown> | null;
        })
      | undefined;
    if (hardbreak) {
      // `create()` fills missing attrs from the cached `defaultAttrs` (and
      // from the live attrs map only for keys present in the passed object),
      // `createAndFill()` reads the cache — patch the map, the cache, and the
      // spec so every construction path sees the soft default
      hardbreak.attrs.isInline.default = true;
      if (hardbreak.defaultAttrs) {
        hardbreak.defaultAttrs = { ...hardbreak.defaultAttrs, isInline: true };
      }
      hardbreak.spec.parseDOM = hardbreak.spec.parseDOM?.map((rule) =>
        rule.tag === 'br' ? { ...rule, getAttrs: () => ({ isInline: false }) } : rule,
      );
    }

    const paragraph = schema.nodes.paragraph as
      | (NodeType & {
          spec: {
            toMarkdown?: {
              match: (node: unknown) => boolean;
              runner: (
                state: { openNode: (type: string) => unknown; closeNode: () => unknown },
                node: { childCount: number },
              ) => void;
            };
          };
        })
      | undefined;
    const stockToMarkdown = paragraph?.spec.toMarkdown;
    if (paragraph && stockToMarkdown) {
      paragraph.spec.toMarkdown = {
        ...stockToMarkdown,
        runner: (state, node) => {
          if (node.childCount === 0) {
            state.openNode('paragraph');
            state.closeNode();
            return;
          }
          stockToMarkdown.runner(state, node);
        },
      };
    }

    // DOMParser captures parseDOM rules when first built — drop whatever may
    // already be cached so the pinned `<br>` rule takes effect
    delete (schema as unknown as { cached: Record<string, unknown> }).cached
      ?.domParser;
    delete (schema as unknown as { cached: Record<string, unknown> }).cached
      ?.domSerializer;
  };
};

/**
 * #53 follow-up (owner report 2026-10-06, "вставляется лишний обратный
 * слеш"): a GitHub-style hard break — two spaces before the newline — was
 * rewritten into the backslash form on every visual round-trip. Both are
 * valid CommonMark hard breaks, but the bytes change and the backslash is
 * visible noise in the file.
 *
 * The flavor is preserved end to end:
 *
 *  - a remark plugin (breakFlavorTagger, registered before Crepe's own
 *    $remark plugins, so it sees the tree first) slices the source at each
 *    break node's position: a slice starting with `\` is the backslash
 *    flavor, one starting with spaces is the two-space flavor. The tag goes
 *    onto `node.data` — the same channel the stock hardbreak parse runner
 *    already reads (`node.data.isInline`);
 *  - the parse runner (patched below, SchemaReady manner) carries the flavor
 *    into a `twoSpace` attr; the serializer runner puts it back onto the
 *    mdast break node as a `twoSpace` prop;
 *  - a custom `handlers.break` in remark-stringify (forwarded through
 *    remarkStringifyOptionsCtx — verified: remark-stringify passes handlers
 *    to mdast-util-to-markdown verbatim) renders the two-space form. The
 *    no-unconditional-eol fallback (setext/table contexts) mirrors the stock
 *    handler's space degradation.
 *
 * Soft breaks (plain `\n`, Shift+Enter) keep their text-node path; the DOM
 * round-trip carries the flavor through a `data-twospace` attribute.
 */
const breakFlavorTagger = $remark('prosa-break-flavor', () => () => {
  return (tree: unknown, file: { value?: unknown }) => {
    const source = typeof file?.value === 'string' ? file.value : '';
    const walk = (node: unknown): void => {
      if (node && typeof node === 'object' && 'type' in node) {
        const n = node as {
          type: string;
          children?: unknown[];
          data?: Record<string, unknown>;
          position?: { start?: { offset?: number }; end?: { offset?: number } };
        };
        if (n.type === 'break' && n.position) {
          const start = n.position.start?.offset;
          const end = n.position.end?.offset;
          const slice = start != null && end != null ? source.slice(start, end) : '';
          const flavor = slice.startsWith(' ') ? 'twospace' : 'backslash';
          n.data = { ...n.data, hardBreakFlavor: flavor };
        }
        n.children?.forEach(walk);
      }
    };
    walk(tree);
  };
});

const hardBreakFlavorFix: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(SchemaReady);
    const schema = ctx.get(schemaCtx);
    const hardbreak = schema.nodes.hardbreak as
      | (NodeType & {
          attrs: Record<string, { default: unknown; hasDefault?: boolean; validate?: (value: unknown) => void }>;
          defaultAttrs: Record<string, unknown> | null;
          spec: {
            attrs?: Record<string, unknown>;
            parseDOM?: { tag?: string; getAttrs?: (dom: HTMLElement) => Record<string, unknown> | null | false }[];
            parseMarkdown?: {
              match: (node: unknown) => boolean;
              runner: (
                state: { addNode: (type: unknown, attrs?: unknown) => unknown },
                node: { data?: { isInline?: boolean; hardBreakFlavor?: string } },
                type: unknown,
              ) => void;
            };
            toMarkdown?: {
              match: (node: unknown) => boolean;
              runner: (
                state: { addNode: (type: string, value?: unknown, children?: unknown, props?: Record<string, unknown>) => unknown },
                node: { attrs: Record<string, unknown> },
              ) => void;
            };
            toDOM?: (node: { attrs: Record<string, unknown> }) => unknown;
          };
        })
      | undefined;
    if (!hardbreak) return;

    hardbreak.spec.attrs = { ...hardbreak.spec.attrs, twoSpace: { default: false, validate: 'boolean' } };
    hardbreak.attrs.twoSpace = { hasDefault: true, default: false };
    if (hardbreak.defaultAttrs) {
      hardbreak.defaultAttrs = { ...hardbreak.defaultAttrs, twoSpace: false };
    }

    const parse = hardbreak.spec.parseMarkdown!;
    hardbreak.spec.parseMarkdown = {
      ...parse,
      runner: (state, node, type) => {
        state.addNode(type, {
          isInline: Boolean(node.data?.isInline),
          twoSpace: node.data?.hardBreakFlavor === 'twospace',
        });
      },
    };

    const toMarkdown = hardbreak.spec.toMarkdown!;
    hardbreak.spec.toMarkdown = {
      ...toMarkdown,
      runner: (state, node) => {
        if (node.attrs.isInline) {
          state.addNode('text', undefined, '\n');
        } else if (node.attrs.twoSpace) {
          state.addNode('break', undefined, undefined, { twoSpace: true });
        } else {
          state.addNode('break');
        }
      },
    };

    // carry the flavor through the clipboard PM→DOM→PM round-trip
    const stockToDOM = hardbreak.spec.toDOM;
    if (stockToDOM) {
      hardbreak.spec.toDOM = (node) => {
        const spec = stockToDOM(node) as [string, Record<string, unknown>, ...unknown[]];
        if (node.attrs.twoSpace && Array.isArray(spec) && spec[1]) {
          spec[1]['data-twospace'] = 'true';
        }
        return spec;
      };
    }
    hardbreak.spec.parseDOM = hardbreak.spec.parseDOM?.map((rule) =>
      rule.tag === 'br'
        ? {
            ...rule,
            // `isInline: false` is lineBreaksFix's pin (a DOM `<br>` is the
            // hard flavor; without it the new default would soften every
            // break on the clipboard round-trip) — keep it AND read the
            // two-space flavor back
            getAttrs: (dom: HTMLElement) => ({
              isInline: false,
              twoSpace: dom.getAttribute('data-twospace') === 'true',
            }),
          }
        : rule,
    );

    delete (schema as unknown as { cached: Record<string, unknown> }).cached?.domParser;
    delete (schema as unknown as { cached: Record<string, unknown> }).cached?.domSerializer;
  };
};

/**
 * #54 (image round-trip, critical): Crepe's image-block design destroys image
 * metadata by construction. Its parse runner reads `caption` from the mdast
 * `title` (null for `![alt](url)` without a title → PM rejects null for a
 * string attr → the parser's addNode catches the RangeError and silently
 * DROPS the image — several images in a document, only titled ones survive),
 * and it stashes the block's UI resize `ratio` IN THE ALT TEXT
 * (`Number(node.alt || 1)`), while the serializer writes alt back as
 * `ratio.toFixed(2)` — every save rewrites `![alt](…)` into `![1.00](…)`.
 *
 * This patch runs right after SchemaReady, in the tableAlignmentFix manner:
 *
 *  - give image-block a real `alt` attr (added post-build: the live attrs map
 *    + `Attribute` instance + the cached `defaultAttrs`, which `create()`
 *    reads on the map and `createAndFill()` on the cache);
 *  - parse runner: null-guard title/alt, keep the caption↔title mapping
 *    (that's the component's UX: the caption input edits the title), ratio
 *    starts at 1 — UI state no longer leaks into the file through alt;
 *  - serializer: alt is the alt, title only when a caption exists;
 *  - the stock inline `image` node has the same null crash (`title` and
 *    `alt` come straight from mdast where they are null when absent), and
 *    its DOM parse rule fabricates `title` from `alt` on the clipboard
 *    PM→DOM→PM round-trip — both patched here too.
 *
 * The parser/serializer dispatch read the specs off the live NodeTypes at
 * operation time, so these runners apply to every later parse/serialization
 * (same guarantee lineBreaksFix relies on).
 */
const imagesFix: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(SchemaReady);
    const schema = ctx.get(schemaCtx);

    type Patchable = NodeType & {
      attrs: Record<string, { default: unknown; hasDefault?: boolean; validate?: (value: unknown) => void }>;
      defaultAttrs: Record<string, unknown> | null;
      spec: {
        attrs?: Record<string, unknown>;
        parseDOM?: { tag?: string; getAttrs?: (dom: HTMLElement) => Record<string, unknown> | null | false }[];
        parseMarkdown?: {
          match: (node: unknown) => boolean;
          runner: (
            state: { addNode: (type: unknown, attrs?: unknown) => unknown; openNode: (type: string) => unknown; closeNode: () => unknown },
            node: { url?: unknown; alt?: unknown; title?: unknown },
            type: unknown,
          ) => void;
        };
        toMarkdown?: {
          match: (node: unknown) => boolean;
          runner: (
            state: { addNode: (type: string, value?: unknown, children?: unknown, props?: Record<string, unknown>) => unknown; openNode: (type: string) => unknown; closeNode: () => unknown },
            node: { attrs: Record<string, unknown> },
          ) => void;
        };
      };
    };
    const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

    const imageBlock = schema.nodes['image-block'] as Patchable | undefined;
    if (imageBlock) {
      imageBlock.spec.attrs = { ...imageBlock.spec.attrs, alt: { default: '', validate: 'string' } };
      // prosemirror-model keeps its Attribute class private — the shape it
      // reads (hasDefault/default; validate is optional and every writer of
      // this attr is below) is all that's needed; `isRequired` stays absent,
      // which `hasRequiredAttrs` treats as "has a default" — correct here
      imageBlock.attrs.alt = { hasDefault: true, default: '' };
      if (imageBlock.defaultAttrs) {
        imageBlock.defaultAttrs = { ...imageBlock.defaultAttrs, alt: '' };
      }

      const parse = imageBlock.spec.parseMarkdown!;
      imageBlock.spec.parseMarkdown = {
        ...parse,
        runner: (state, node, type) => {
          state.addNode(type, {
            src: asString(node.url),
            caption: asString(node.title),
            ratio: 1,
            alt: asString(node.alt),
          });
        },
      };

      const toMarkdown = imageBlock.spec.toMarkdown!;
      imageBlock.spec.toMarkdown = {
        ...toMarkdown,
        runner: (state, node) => {
          state.openNode('paragraph');
          state.addNode('image', undefined, undefined, {
            title: (node.attrs.caption as string) || null,
            url: node.attrs.src,
            alt: (node.attrs.alt as string) || '',
          });
          state.closeNode();
        },
      };

      imageBlock.spec.parseDOM = imageBlock.spec.parseDOM?.map((rule) =>
        rule.tag === 'img[data-type="image-block"]'
          ? {
              ...rule,
              getAttrs: (dom: HTMLElement) => {
                const base = rule.getAttrs?.(dom);
                if (!base || typeof base !== 'object') return base ?? null;
                return { ...base, alt: dom.getAttribute('alt') || '' };
              },
            }
          : rule,
      );
    }

    const image = schema.nodes['image'] as Patchable | undefined;
    if (image) {
      const parse = image.spec.parseMarkdown!;
      image.spec.parseMarkdown = {
        ...parse,
        runner: (state, node, type) => {
          state.addNode(type, {
            src: asString(node.url),
            alt: asString(node.alt),
            title: asString(node.title),
          });
        },
      };
      // `title || alt` fabricates a title for every DOM image without one —
      // after the clipboard round-trip the save would write `![alt](url "alt")`
      image.spec.parseDOM = image.spec.parseDOM?.map((rule) =>
        rule.tag === 'img[src]'
          ? {
              ...rule,
              getAttrs: (dom: HTMLElement) => ({
                src: dom.getAttribute('src') || '',
                alt: dom.getAttribute('alt') || '',
                title: dom.getAttribute('title') || '',
              }),
            }
          : rule,
      );
    }

    // parseDOM rules are captured when DOMParser.fromSchema first builds —
    // drop whatever may already be cached (same as tableAlignmentFix)
    delete (schema as unknown as { cached: Record<string, unknown> }).cached?.domParser;
    delete (schema as unknown as { cached: Record<string, unknown> }).cached?.domSerializer;
  };
};

/**
 * #55 (link reference definitions vanish): milkdown's commonmark preset runs
 * `remark-inline-links`, which resolves every `[text][id]` reference into an
 * inline link AND splices all `definition` nodes out of the tree — the model
 * never sees them, so every save silently deletes `[id]: url` blocks and the
 * `[//]: # (comment)` trick. Restoring them inside the model is not possible
 * without a schema rebuild, so this fix works at the two boundaries the app
 * owns:
 *
 *  - capture: every whole-document markdown source (open, mode switch,
 *    `setMarkdown`) and every plain-text paste are scanned for
 *    definition-looking lines OUTSIDE fenced/indented code; the raw line is
 *    stored byte-exact, keyed by the normalized identifier (first wins, as
 *    in CommonMark). Pasted fragments only ADD definitions (a document's own
 *    defs can't be deleted from visual mode — they're invisible there);
 *  - restore: the serializer slice is wrapped to append the captured block
 *    back when (and only when) the WHOLE document is serialized — a fragment
 *    copy must not drag the document's definitions along. References
 *    themselves still serialize inline (the audit's accepted compromise:
 *    bytes change at the reference, the definition survives, position moves
 *    to the end of the document).
 *
 * Known heuristic limits (L1, documented in #55): titles on the line AFTER
 * the destination, definitions inside blockquotes, and definition-looking
 * lines inside html blocks are not captured. The block is re-emitted at the
 * document end, which is a stable round-trip position (a reopen recaptures
 * it there and re-emits the same bytes).
 */
const makeLinkReferenceFix = (getDefinitions: () => Map<string, string>): MilkdownPlugin => (ctx) => {
  return async () => {
    await ctx.wait(SerializerReady);
    const stockSerializer = ctx.get(serializerCtx);
    ctx.set(serializerCtx, (content: ProseNode) => {
      const markdown = stockSerializer(content);
      // only the whole document is normalized and carries its definitions
      // block back — partial copies and ranged serializations stay untouched.
      // The view does not exist yet while the editor state boots (the listener
      // plugin already serializes during EditorState.create): without the
      // guard those early serializations would crash reading view.state
      const view = ctx.get(editorViewCtx) as { state?: { doc: ProseNode } } | undefined;
      // the slice holds a throwing placeholder until the real view mounts
      if (!view || typeof view !== 'object' || !view.state || !content.eq(view.state.doc)) {
        return markdown;
      }
      const body = markdown.replace(/\s+$/, '');
      const defs = [...getDefinitions().values()];
      if (defs.length === 0) return body ? `${body}\n` : '';
      return body
        ? `${body}\n\n${defs.join('\n')}\n`
        : `${defs.join('\n')}\n`;
    });
  };
};

/**
 * A link reference definition, outside code fences/indented code (#55).
 * Footnote definitions `[^id]: …` are a different mdast node (Crepe keeps
 * them in the model) and must NOT match — without the `^` guard they would
 * be re-emitted by the serializer on top of their own stock serialization,
 * duplicating on every edit/save cycle (review B1).
 */
const DEFINITION_LINE =
  /^ {0,3}\[(?!\^)((?:\\.|[^\\[\]])+)\]:\s*(?:<[^<>]*>|\S+)\s*(?:"[^"]*"|'[^']*'|\([^)]*\))?\s*$/;

/** Lines after which a definition may START (CommonMark: a definition cannot interrupt a paragraph). */
const DEF_CONTEXT_LINE = /^ {0,3}(?:#{1,6}\s|=+\s*$|(-{3,}|\*{3,}|_{3,})\s*$)/;

/** See makeLinkReferenceFix: capture definition lines from raw markdown. */
function captureDefinitions(markdown: string, store: Map<string, string>, reset: boolean): void {
  if (reset) store.clear();
  let fence: { marker: string; length: number } | null = null;
  // a definition can only start the line flow: at the document start, after
  // a blank line, another definition, or a block that closes a paragraph
  // (heading / setext underline / thematic break / closing fence). A
  // definition-looking line continuing a paragraph, list item or table row
  // is plain text there — capturing it would duplicate it on save (review M1)
  let defAllowed = true;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // a closing fence is the fence marker alone, at least as long as the opener
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
        fence = null;
        defAllowed = true;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    if (line.trim() === '') {
      defAllowed = true;
      continue;
    }
    if (/^ {4,}/.test(line)) continue; // indented code block content
    const match = defAllowed && DEFINITION_LINE.exec(line);
    if (match) {
      // CommonMark identifier normalization; first definition wins, as in remark
      const key = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
      if (!store.has(key)) store.set(key, line.trim());
      continue;
    }
    defAllowed = DEF_CONTEXT_LINE.test(line);
  }
}

/** mdast-util-to-markdown's patternInScope, inlined for the break handler. */
function patternInScope(
  stack: string[],
  pattern: { inConstruct?: string | string[] | null; notInConstruct?: string | string[] | null },
): boolean {
  return listInScope(stack, pattern.inConstruct, true) && !listInScope(stack, pattern.notInConstruct, false);
}

function listInScope(stack: string[], list: string | string[] | null | undefined, none: boolean): boolean {
  if (!list || list.length === 0) return none;
  for (const item of Array.isArray(list) ? list : [list]) {
    if (stack.includes(item)) return true;
  }
  return false;
}

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
  // #66: the reading mode — this same instance with `editable` off
  private readonly = false;

  // The link-edit tooltip's own Escape handler sits on its <input> (and stops
  // propagation there), but after Ctrl+K the focus can remain in the editor —
  // there Escape dies and the tooltip stays open. Catch it before the editor
  // and hand it to the input: focusing the input first both lets the
  // component's own cancel path run on the re-dispatched key and makes this
  // same listener ignore that synthetic key (the tooltip-contains-focus
  // guard) — re-dispatching without the focus change loops forever, as the
  // capture listener keeps eating its own event.
  private escapeLinkTooltip = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const tooltip = this.root?.querySelector('.milkdown-link-edit[data-show="true"]');
    if (!tooltip || tooltip.contains(document.activeElement)) return;
    // only when the editor surface itself has focus: a modal dialog opened
    // on top (About, hotkeys) must keep Escape for itself
    if (!this.root?.contains(document.activeElement)) return;
    const input = tooltip.querySelector('input');
    if (!input) return;
    e.preventDefault();
    e.stopPropagation();
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  };

  // #59 (internal anchors): headings already carry auto-IDs (the stock
  // sync-heading-id plugin assigns them on every doc change and heading toDOM
  // writes them into the DOM), but nothing intercepted `[text](#id)` clicks —
  // the WebView shelled them out to the system browser. This capture-phase
  // handler always cancels the navigation for `#`-links; inside the editor
  // body it only FOLLOWS the anchor on Ctrl/Cmd+click (Typora/Obsidian/VS
  // Code convention — a plain click keeps editing the link text: the caret
  // lands there on mousedown, which preventDefault on click doesn't touch).
  // Outside the body (the link tooltip's preview anchor) a plain click
  // follows — and so does a plain click anywhere in the reading mode (#66:
  // nothing to edit there). Targets use the GFM slug; duplicate headings get our `-#k`
  // suffixes, so a GitHub-style `#slug-1` falls back to the second heading
  // with that slug (GitHub numbers duplicates 1, 2, … starting at the second).
  private anchorClickHandler = (e: MouseEvent) => {
    const anchor = (e.target as Element | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (!anchor) return;
    e.preventDefault();
    const inEditorBody = anchor.closest('.ProseMirror') !== null;
    if (inEditorBody && !this.readonly && !e.ctrlKey && !e.metaKey) return;
    let id = '';
    try {
      id = decodeURIComponent(anchor.hash.slice(1));
    } catch {
      return; // malformed percent-encoding — nothing to scroll to
    }
    if (!id || !this.root) return;
    let target: Element | null = this.root.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) {
      const gh = /^(.*)-(\d+)$/.exec(id);
      if (gh) {
        const duplicates = [...this.root.querySelectorAll('[id]')].filter(
          (el) => el.id === gh[1] || el.id.startsWith(`${gh[1]}-#`),
        );
        // gh[2] = 1 means the SECOND heading with the slug (GitHub numbers from the second occurrence)
        target = duplicates[Number(gh[2])] ?? null;
      }
    }
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // #64: footnotes render (`sup` reference ↔ `dl` definition, both carry
  // data-label) but nothing is clickable. Obsidian-style navigation: a plain
  // click on the reference jumps to its definition — the marker is
  // contenteditable=false, so a plain click has no editing meaning to steal.
  // The way back (owner follow-up: Ctrl+click on the label was invisible) is
  // a plain click on the definition's number (dt) or on the "↩" that CSS
  // paints after it (`dl::after`, styles.css): it scrolls to the first
  // reference of that label. The dt is not editable content — it is the
  // node's toDOM mirror of the label outside the contentDOM (dd), so a plain
  // click there steals nothing in the live preview either. The arrow is a
  // pseudo-element (the nodeView rebuilds the dl on every transaction, so no
  // DOM can be injected there): its clicks land on the dl itself, told apart
  // from gap clicks by lying past the dd's right edge. A missing definition
  // or reference is a silent no-op. Labels are matched by iteration, not an
  // attribute selector — a footnote label may contain quotes.
  private footnoteClickHandler = (e: MouseEvent) => {
    const target = e.target as Element | null;
    const byLabel = (sel: string, label: string): Element | null =>
      [...(this.root?.querySelectorAll(sel) ?? [])].find(
        (el) => el.getAttribute('data-label') === label,
      ) ?? null;
    const ref = target?.closest?.('sup[data-type="footnote_reference"]');
    if (ref) {
      e.preventDefault();
      const def = byLabel('dl[data-type="footnote_definition"]', ref.getAttribute('data-label') ?? '');
      def?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (def) this.flashTarget(def);
      return;
    }
    const dl = target?.closest?.('dl[data-type="footnote_definition"]');
    if (!dl || !target) return;
    let onBack = target.closest('dl[data-type="footnote_definition"] > dt')?.parentElement === dl;
    if (!onBack && target === dl) {
      const dd = dl.querySelector(':scope > dd');
      onBack = dd !== null && e.clientX >= dd.getBoundingClientRect().right;
    }
    if (!onBack) return;
    e.preventDefault();
    const back = byLabel('sup[data-type="footnote_reference"]', dl.getAttribute('data-label') ?? '');
    back?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (back) this.flashTarget(back);
  };

  // #64: the landing-point highlight. The footnote definition's DOM is
  // recreated by its nodeView on every ProseMirror transaction (verified: a
  // plain click on an unrelated paragraph replaces the dl node), so a class
  // painted on the target dies with it. Instead an overlay outside the
  // editor tree — fixed, tracked to the target's live rect by rAF — follows
  // the element through the smooth scroll and survives node replacement
  // (if the node is replaced mid-flash, isConnected ends the loop).
  private flashTarget(el: Element): void {
    const overlay = document.createElement('div');
    overlay.className = 'prosa-flash-overlay';
    document.body.appendChild(overlay);
    const end = performance.now() + 1250;
    const track = () => {
      if (!el.isConnected || performance.now() > end) {
        overlay.remove();
        return;
      }
      const r = el.getBoundingClientRect();
      overlay.style.width = `${Math.max(r.width, 8)}px`;
      overlay.style.height = `${Math.max(r.height, 8)}px`;
      overlay.style.transform = `translate(${r.left}px, ${r.top}px)`;
      requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
  };

  // #65: an inline image whose fetch fails (dead URL — a 404 HTML page gets
  // ORB-blocked, offline files, hotlink protection) collapses to an invisible
  // 0×0: the component forces display:block, and Chromium only paints alt
  // text for broken *inline* images, so the paragraph reads as empty. Capture
  // error/load on the container — resource errors don't bubble, but they do
  // pass through ancestors in the capture phase. The sweep is a safety net
  // for failures that complete before the first paint.
  private imageStatusHandler = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('image-inline')) return;
    const span = img.closest<HTMLElement>('span.milkdown-image-inline');
    if (!span) return;
    if (e.type === 'error') {
      this.markImageBroken(span, img);
    } else {
      span.classList.remove('prosa-img-broken');
      delete span.dataset.prosaImg;
    }
  };

  private markImageBroken(span: HTMLElement, img: HTMLImageElement): void {
    span.classList.add('prosa-img-broken');
    // alt text is content, not UI chrome — no i18n string involved
    span.dataset.prosaImg =
      img.getAttribute('alt') || img.getAttribute('src') || '';
  }

  private sweepBrokenImages(): void {
    for (const img of this.root?.querySelectorAll('img.image-inline') ?? []) {
      if (!(img instanceof HTMLImageElement)) continue;
      if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
        this.markImageBroken(
          img.closest<HTMLElement>('span.milkdown-image-inline') ?? img,
          img,
        );
      }
    }
  }

  // #55: definitions captured from every parsed markdown source (see
  // makeLinkReferenceFix). Instance-level: one editor = one document.
  private definitions = new Map<string, string>();

  private captureDefinitions(markdown: string, reset: boolean): void {
    captureDefinitions(markdown, this.definitions, reset);
  }

  // #55: see create(); code blocks (Crepe's code-mirror feature) and the
  // component input fields (image caption, link tooltip) paste raw —
  // definition-looking lines there are content, not definitions. Rich-text
  // pastes (text/html from browsers/mail/word) go down the HTML path and
  // their plain-text shadow is not markdown to scan either.
  private pasteCaptureHandler = (e: ClipboardEvent) => {
    const target = e.target as Element | null;
    if (target?.closest?.('.cm-editor, pre, code, input, textarea')) return;
    const data = e.clipboardData;
    if (!data) return;
    const types = Array.from(data.types ?? []);
    if (types.includes('text/html')) return;
    const text = data.getData('text/plain');
    if (!text) return;
    const before = this.definitions.size;
    captureDefinitions(text, this.definitions, false);
    // a definitions-only paste changes nothing in the model (they are
    // consumed invisibly), so the change listener never fires and the save
    // would write the untouched raw bytes back, dropping them — mark edited
    if (this.definitions.size > before) this.onChange?.();
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
    // #59: same re-register pattern for the anchor click handler
    root.removeEventListener('click', this.anchorClickHandler, true);
    root.addEventListener('click', this.anchorClickHandler, true);
    // #64: footnote navigation (re-register pattern as above)
    root.removeEventListener('click', this.footnoteClickHandler, true);
    root.addEventListener('click', this.footnoteClickHandler, true);
    // #65: broken inline images must be visible, not 0×0 (capture phase —
    // resource error events don't bubble)
    root.removeEventListener('error', this.imageStatusHandler, true);
    root.removeEventListener('load', this.imageStatusHandler, true);
    root.addEventListener('error', this.imageStatusHandler, true);
    root.addEventListener('load', this.imageStatusHandler, true);
    // #55: plain-text pastes can carry definitions into the document — the
    // parse itself consumes them invisibly (remark-inline-links), so they are
    // captured from the raw clipboard text before ProseMirror handles it.
    // Pasting into a code block keeps the text verbatim — nothing to capture.
    root.removeEventListener('paste', this.pasteCaptureHandler, true);
    root.addEventListener('paste', this.pasteCaptureHandler, true);
    // carried across rebuilds (language switch re-creates the panel too)
    if (panelClipboard) this.panelClipboard = panelClipboard;
    // a rebuild (language switch) remounts everything — clean the old panel first
    this.panel?.destroy();
    // #55: the whole-document source is scanned for link reference
    // definitions before the parse consumes them (see makeLinkReferenceFix)
    this.captureDefinitions(defaultValue, true);
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
    // the "other" bullet for adjacent lists so they cannot merge.
    // `rule: '-'` keeps `---` thematic breaks from turning into `***`.
    //
    // #59: heading auto-IDs follow the GitHub slug shape (lowercase,
    // punctuation dropped, whitespace → dashes, unicode letters kept), so
    // anchors typed by hand after GitHub's rendering resolve in ProsaMD too.
    // The ids live only in the model/DOM — the heading serializer never
    // writes them into the file.
    this.crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options,
        bullet: '-' as const,
        rule: '-' as const,
        // #53 follow-up: two-space hard breaks keep their form (the handler
        // reads the `twoSpace` prop the serializer runner put on the break
        // node; everything else degrades exactly like the stock handler).
        // Mirrors mdast-util-to-markdown's hardBreak: where an unconditional
        // eol is not allowed (setext/table cells), a break degrades to a
        // space — patternInScope inlined below.
        handlers: {
          ...(options.handlers ?? {}),
          break(node: { twoSpace?: boolean }, _parent: unknown, rawState: unknown, rawInfo: unknown): string {
            if (!node.twoSpace) return '\\\n';
            const state = rawState as {
              stack: string[];
              unsafe: { character: string; before?: string | null; after?: string | null; inConstruct?: string | string[] | null; notInConstruct?: string | string[] | null }[];
            };
            const info = rawInfo as { before: string };
            for (const pattern of state.unsafe) {
              if (
                pattern.character === '\n' &&
                !pattern.before &&
                !pattern.after &&
                patternInScope(state.stack, pattern)
              ) {
                return /[\t ]/.test(info.before) ? '' : ' ';
              }
            }
            return '  \n';
          },
        },
      }));
      ctx.update(headingIdGenerator.key, () => (node: ProseNode) =>
        node.textContent
          .trim()
          .toLowerCase()
          // GFM slug shape: drop punctuation (keep letters/digits/marks),
          // then every whitespace character becomes its own dash
          .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
          .replace(/\s/g, '-'),
      );
    });
    this.crepe.editor.use(tableAlignmentFix);
    this.crepe.editor.use(lineBreaksFix);
    this.crepe.editor.use(hardBreakFlavorFix);
    this.crepe.editor.use(imagesFix);
    this.crepe.editor.use(makeLinkReferenceFix(() => this.definitions));
    // registered before Crepe's own $remark plugins: it must see break nodes
    // with their pristine positions to detect the source flavor
    this.crepe.editor.use(breakFlavorTagger);
    // only real document changes count as edits: a DOM-wide mutation observer
    // would misread focus/cursor/block-handle widget mutations as edits
    this.crepe.editor.use(listener);
    // #66: a rebuild (language switch) in the reading mode stays read-only
    this.crepe.setReadonly(this.readonly);
    await this.crepe.create();
    this.crepe.editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated(() => {
        onChange();
        // #65: a doc change can rebuild inline-image DOM without a fresh
        // load error event (cached failure) — resweep on every update
        this.sweepBrokenImages();
      });
    });
    // #65: catches fetch failures that already completed before this point
    // (cached failures); everything later flows through imageStatusHandler
    this.sweepBrokenImages();
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
    // a whole-document replacement: re-capture definitions from the new
    // source (#55) — the parse below consumes them invisibly
    this.captureDefinitions(md, true);
    this.crepe.editor.action(replaceAll(md, true));
  }

  focus(): void {
    const el = this.root?.querySelector('.ProseMirror');
    if (el instanceof HTMLElement) el.focus();
  }

  /**
   * #66: the reading mode. Crepe's own switch flips ProseMirror's `editable`
   * prop (view.setProps) and keeps its components (image/list/table/code
   * views) in sync with it. A props update is not a transaction — the
   * document, the undo history and the change listener stay untouched, so a
   * mode switch never marks the file dirty.
   */
  setReadonly(on: boolean): void {
    if (this.readonly === on) return;
    this.readonly = on;
    this.crepe?.setReadonly(on);
    this.panel?.close();
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

  /** Markdown of the selection — what "Copy" puts on the clipboard (#47). */
  selectionMarkdown(): string {
    return this.crepe ? visualSelectionMarkdown(this.crepe) : '';
  }

  deleteSelection(): void {
    if (this.crepe) visualDeleteSelection(this.crepe);
  }

  insertMarkdown(md: string): void {
    // menu/right-panel paste goes through the parser directly (not the
    // clipboard event), so definitions in it are captured here too (#55)
    captureDefinitions(md, this.definitions, false);
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
