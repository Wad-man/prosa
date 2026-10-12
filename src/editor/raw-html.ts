// #61: raw HTML in the visual mode (owner decision 2026-10-06 — the Typora/
// MarkText approach). The stock commonmark preset models EVERY raw HTML
// fragment as an inline `html` atom with the raw bytes in `value` — the file
// round-trip already works, the rendering is literal text. This module
// upgrades three slices of that, everything else keeps the stock atom:
//
//  1. inline whitelist `kbd`/`sub`/`sup` — a paired STRICT simple-tag form
//     (`<sub>`, `</sub>`; no attributes, no inner whitespace) becomes a real
//     `html-tag` inline node: content stays editable and renders as the tag
//     itself; the original open/close bytes ride in attrs and serialize
//     verbatim (`<SUB>` stays `<SUB>`);
//  2. inline `<br>` variants (`<br>`, `<br/>`, `<br />`) — become a hardbreak
//     carrying the fourth flavor (`htmlRaw`), next to the two-space/backslash/
//     soft flavors of #53/#80: renders as a line break, serializes as the
//     original bytes. A `<br>` alone on a line is a CommonMark HTML BLOCK —
//     that one goes to (3);
//  3. block-level HTML (a `<div>…</div>` block, an HTML table, `<!-- … -->`
//     comments) — becomes an atom `html-block` node displayed as formatted
//     code and NOT rendered as HTML (Obsidian-style rendering is a plugin
//     candidate). The raw block bytes survive verbatim — the node is never
//     converted to a fenced code block.
//
// Not upgraded (honest L0, byte-exact round-trip): tags outside the whitelist
// (`<span>`, `<a id>`, …), attribute-carrying forms (`<sub class="x">`),
// unclosed pairs and same-tag nesting (the inner pair stays literal inside
// the outer tag). Editing of block HTML happens in the source mode.
import { $node, $remark } from '@milkdown/kit/utils';

/** Minimal mdast shape this walk needs (remark keeps extra keys untouched). */
type MdNode = {
  type: string;
  value?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown> | null;
  position?: unknown;
  tag?: string;
  rawOpen?: string;
  rawClose?: string;
};

/** Containers whose DIRECT html children are block-level (CommonMark block contexts). */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** Strict forms only — attribute-carrying or spaced tags stay literal text. */
const INLINE_OPEN = /^<(sub|sup|kbd)>$/i;
const INLINE_CLOSE = /^<\/(sub|sup|kbd)>$/i;
const BR_FORM = /^<br\s*\/?\s*>$/i;

/** `<br>` variant → hardbreak with the `htmlRaw` flavor (see hardBreakFlavorFix). */
const convertBr = (node: MdNode): MdNode =>
  node.type === 'html' && typeof node.value === 'string' && BR_FORM.test(node.value)
    ? {
        type: 'break',
        data: { isInline: false, hardBreakFlavor: 'html', htmlRaw: node.value },
        position: node.position,
      }
    : node;

type Frame = {
  tag: string;
  rawOpen: string;
  content: MdNode[];
  /** opens of the SAME tag seen inside this frame — their closes stay literal */
  sameTagDepth: number;
  position: unknown;
};

/**
 * Pair whitelisted inline tags in one inline-content array. Unmatched opens
 * and stray/cross-nested closes degrade back to stock html atoms (literal
 * text), so a typo in the source never loses bytes.
 */
const pairInline = (children: MdNode[]): MdNode[] => {
  const out: MdNode[] = [];
  const stack: Frame[] = [];
  const sink = (): MdNode[] => (stack.length > 0 ? stack[stack.length - 1].content : out);

  for (const raw of children) {
    const node = convertBr(raw);
    if (node.type === 'html' && typeof node.value === 'string') {
      const open = INLINE_OPEN.exec(node.value);
      if (open) {
        const tag = open[1].toLowerCase();
        const same = stack.find((f) => f.tag === tag);
        if (same) {
          // same-tag nesting: the inner pair renders as literal text inside
          // the outer tag (documented limit — no nested whitelist rendering)
          same.sameTagDepth += 1;
          sink().push(node);
        } else {
          stack.push({ tag, rawOpen: node.value, content: [], sameTagDepth: 0, position: node.position });
        }
        continue;
      }
      const close = INLINE_CLOSE.exec(node.value);
      if (close) {
        const tag = close[1].toLowerCase();
        const top = stack[stack.length - 1];
        if (top && top.tag === tag) {
          if (top.sameTagDepth > 0) {
            top.sameTagDepth -= 1;
            sink().push(node);
          } else {
            stack.pop();
            sink().push({
              type: 'prosaHtmlTag',
              tag: top.tag,
              rawOpen: top.rawOpen,
              rawClose: node.value,
              children: pairInline(top.content),
              position: top.position,
            });
          }
        } else {
          sink().push(node); // stray or cross-nested close — stays literal
        }
        continue;
      }
    }
    sink().push(node);
  }

  // unclosed opens flush as literal text, innermost first, so their collected
  // content lands back in the right container
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const host = sink();
    host.push({ type: 'html', value: frame.rawOpen, position: frame.position });
    host.push(...pairInline(frame.content));
  }
  return out;
};

const walk = (node: MdNode): void => {
  if (!Array.isArray(node.children)) return;
  if (BLOCK_PARENTS.has(node.type)) {
    node.children = node.children.map((child) => {
      // a bare html node in a block context (a pipeline without the preset
      // transformer — kept for robustness)
      if (child.type === 'html') return toHtmlBlock(child);
      // the preset's remarkHtmlTransformer has already rewritten block html
      // into paragraph>{single html leaf} by the time this walk runs. A
      // single-html paragraph in a block context is exactly that shape —
      // CommonMark type-7 html blocks are the only paragraphs mdast builds
      // this way (the empty-line `<br />` placeholder is deleted by the
      // preset's preserve-empty-line plugin before this point, so an empty
      // paragraph never matches)
      if (
        child.type === 'paragraph' &&
        child.children?.length === 1 &&
        child.children[0].type === 'html'
      ) {
        return toHtmlBlock(child.children[0]);
      }
      return child;
    });
  } else {
    node.children = pairInline(node.children);
  }
  node.children.forEach(walk);
};

const toHtmlBlock = (html: MdNode): MdNode => ({
  type: 'prosaHtmlBlock',
  value: typeof html.value === 'string' ? html.value : '',
  position: html.position,
});

/**
 * Runs before breakFlavorTagger (registration order): br-converted break
 * nodes already carry `hardBreakFlavor: 'html'`, and the tagger skips
 * pre-flavored nodes, so it cannot rewrite them to 'backslash'.
 */
export const rawHtmlTagger = $remark('prosa-raw-html', () => () => (tree: unknown) => {
  if (tree && typeof tree === 'object' && 'type' in tree) walk(tree as MdNode);
});

/** Clipboard PM→DOM→PM round-trip: the raw bytes ride in data attributes. */
const readTagAttrs = (dom: HTMLElement | string): Record<string, string> => {
  if (typeof dom === 'string') return { tag: 'kbd', rawOpen: '<kbd>', rawClose: '</kbd>' };
  const tag = dom.tagName.toLowerCase();
  return {
    tag,
    rawOpen: dom.getAttribute('data-raw-open') ?? `<${tag}>`,
    rawClose: dom.getAttribute('data-raw-close') ?? `</${tag}>`,
  };
};

/**
 * The paired inline whitelist node. Serialized as two sibling mdast `html`
 * nodes (open tag, close tag) around the serialized content — mdast-util-to-
 * markdown writes html values verbatim, which is the byte-exact guarantee.
 * A rich-text paste from outside creates it with canonical `<tag>` bytes
 * (nothing to preserve there — it is new content, not a round-trip).
 */
export const htmlTagNode = $node('html-tag', () => ({
  inline: true,
  group: 'inline',
  content: 'inline*',
  attrs: {
    tag: { default: 'kbd', validate: 'string' },
    rawOpen: { default: '<kbd>', validate: 'string' },
    rawClose: { default: '</kbd>', validate: 'string' },
  },
  toDOM: (node) => [
    node.attrs.tag as string,
    { 'data-raw-open': node.attrs.rawOpen, 'data-raw-close': node.attrs.rawClose },
    0,
  ],
  parseDOM: [
    { tag: 'kbd', getAttrs: readTagAttrs },
    { tag: 'sub', getAttrs: readTagAttrs },
    { tag: 'sup', getAttrs: readTagAttrs },
  ],
  parseMarkdown: {
    match: (node) => node.type === 'prosaHtmlTag',
    runner: (state, node, type) => {
      state.openNode(type, { tag: node.tag, rawOpen: node.rawOpen, rawClose: node.rawClose });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'html-tag',
    runner: (state, node) => {
      // FLAT siblings at the paragraph level, not a container: mdast's html
      // handler writes `value` and ignores children, so an open-node wrapper
      // would swallow the content on stringify
      state.addNode('html', undefined, node.attrs.rawOpen);
      state.next(node.content);
      state.addNode('html', undefined, node.attrs.rawClose);
    },
  },
}));

/**
 * Block-level HTML as formatted code (NOT rendered). Atom: edits happen in
 * the source mode — an accidental Enter inside must not rewrite the block's
 * structure. The value keeps the whole raw block (mdast merges an HTML block
 * into one node), serialized back as a single mdast `html` node, verbatim.
 */
export const htmlBlockNode = $node('html-block', () => ({
  atom: true,
  group: 'block',
  attrs: { value: { default: '', validate: 'string' } },
  toDOM: (node) => [
    'pre',
    { class: 'prosa-html-block', 'data-type': 'html-block', 'data-value': node.attrs.value },
    ['code', node.attrs.value],
  ],
  parseDOM: [
    {
      tag: 'pre[data-type="html-block"]',
      // #61: milkdown's clipboard runs every text/plain paste through a
      // DOMSerializer→DOMParser round-trip, and code_block's plain `pre`
      // rule (default priority 50, registered earlier) would swallow this
      // element — a higher priority sorts our rule ahead of it
      priority: 60,
      getAttrs: (dom) => ({
        value: typeof dom === 'string' ? '' : dom.getAttribute('data-value') ?? '',
      }),
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === 'prosaHtmlBlock',
    runner: (state, node, type) => state.addNode(type, { value: node.value ?? '' }),
  },
  toMarkdown: {
    match: (node) => node.type.name === 'html-block',
    runner: (state, node) => state.addNode('html', undefined, node.attrs.value),
  },
}));
