// #61: raw HTML in the visual mode (owner decision 2026-10-06 — the Typora/
// MarkText approach). The stock commonmark preset models EVERY raw HTML
// fragment as an inline `html` atom with the raw bytes in `value` — the file
// round-trip already works, the rendering is literal text. This module
// upgrades three slices of that, everything else keeps the stock atom:
//
//  1. inline whitelist `kbd`/`sub`/`sup` — a paired STRICT simple-tag form
//     (`<sub>`, `</sub>`; no attributes, no inner whitespace) becomes the
//     `html_tag` MARK over the content (a mark, not an inline node-with-
//     content: milkdown's parser resets its mark stack in closeNode and its
//     serializer closes open marks after a nested container's last child —
//     an outer `**bold <kbd>…</kbd>**` or a link spanning the tag would
//     silently lose formatting, review MAJOR-1/2). The mark renders as the
//     tag itself; the original open/close bytes ride in attrs and serialize
//     verbatim (`<SUB>` stays `<SUB>`);
//  2. inline `<br>` variants (`<br>`, `<br/>`, `<br />`) — become a hardbreak
//     carrying the fourth flavor (`htmlRaw`), next to the two-space/backslash/
//     soft flavors of #53/#80: renders as a line break, serializes as the
//     original bytes. A lone `<br>` line is a CommonMark HTML block that the
//     preset's preserve-empty-line plugin already treats as the empty-line
//     placeholder — it opens as an empty paragraph, it does NOT reach (3);
//  3. block-level HTML (a `<div>…</div>` block, an HTML table, `<!-- … -->`
//     comments) — becomes an atom `html-block` node displayed as formatted
//     code and NOT rendered as HTML (Obsidian-style rendering is a plugin
//     candidate). The raw block bytes survive verbatim — the node is never
//     converted to a fenced code block.
//
// Not upgraded (honest L0, byte-exact round-trip): tags outside the whitelist
// (`<span>`, `<a id>`, …), attribute-carrying forms (`<sub class="x">`),
// unclosed pairs. Same-tag nesting pairs again recursively — the bytes stay
// correct either way. Editing of block HTML happens in the source mode.
import { $mark, $node, $remark } from '@milkdown/kit/utils';

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
  pid?: number;
};

/** Containers whose DIRECT html children are block-level (CommonMark block contexts). */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** Strict forms only — attribute-carrying or spaced tags stay literal text. */
const INLINE_OPEN = /^<(sub|sup|kbd)>$/i;
const INLINE_CLOSE = /^<\/(sub|sup|kbd)>$/i;
const BR_FORM = /^<br\s*\/?\s*>$/i;

/** Pair discriminator, unique per parsed pair: two adjacent identical pairs
 * (`<kbd>a</kbd><kbd>b</kbd>`) must not merge into one mark span — equal
 * attrs would fold them into `<kbd>ab</kbd>` and change the file's bytes. */
let pairSeq = 0;

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
              pid: ++pairSeq,
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

const toHtmlBlock = (html: MdNode): MdNode => ({
  type: 'prosaHtmlBlock',
  value: typeof html.value === 'string' ? html.value : '',
  position: html.position,
});

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

/** The tree transform itself — reused by «Copy for Word» (markdown-html.ts):
 * paired whitelist tags become `prosaHtmlTag`, `<br>` variants become break
 * nodes, block HTML becomes `prosaHtmlBlock`. */
export const prosaRawHtmlTransform = (tree: MdNode): void => {
  walk(tree);
};

/**
 * Runs before breakFlavorTagger (registration order): br-converted break
 * nodes already carry `hardBreakFlavor: 'html'`, and the tagger skips
 * pre-flavored nodes, so it cannot rewrite them to 'backslash'.
 */
export const rawHtmlTagger = $remark('prosa-raw-html', () => () => (tree: unknown) => {
  if (tree && typeof tree === 'object' && 'type' in tree) walk(tree as MdNode);
});

/**
 * The paired inline whitelist, as THREE separate marks (html_kbd / html_sub /
 * html_sup) — a ProseMirror mark set cannot hold the same mark type twice,
 * so one mark type carrying the tag in attrs would make nested forms like
 * `<kbd>a<sub>b</sub>c</kbd>` impossible (the outer mark is silently
 * replaced by the inner on the shared text, verified against stock
 * prosemirror-model's DOM round-trip).
 *
 * Serialization: each mark's toMarkdown wraps the text into a custom
 * `prosaHtmlTag` mdast node (with a `tag` prop); remark-stringify writes it
 * through the `prosaHtmlTag` handler in visual.ts's remarkStringifyOptions
 * (`rawOpen + containerPhrasing + rawClose`) — the handler, not a container
 * node, because mdast's stock html handler writes `value` only and would
 * drop the children. The `pid` attr keeps two ADJACENT identical pairs
 * (`<kbd>a</kbd><kbd>b</kbd>`) from folding into one mark span.
 */
const makeHtmlTagMark = (tag: 'kbd' | 'sub' | 'sup') =>
  $mark(`html_${tag}`, () => ({
    inclusive: false,
    attrs: {
      rawOpen: { default: `<${tag}>`, validate: 'string' },
      rawClose: { default: `</${tag}>`, validate: 'string' },
      pid: { default: 0, validate: 'number' },
    },
    parseDOM: [
      {
        tag,
        // external rich-text pastes carry the raw bytes in data attributes —
        // validate them (review MINOR-3): an outside page must not write
        // arbitrary bytes into the document
        getAttrs: (dom) => {
          if (typeof dom === 'string') return { pid: ++pairSeq };
          const open = dom.getAttribute('data-raw-open');
          const close = dom.getAttribute('data-raw-close');
          const pid = Number(dom.getAttribute('data-pid'));
          return {
            rawOpen:
              open != null && INLINE_OPEN.test(open) && open.toLowerCase() === `<${tag}>` ? open : `<${tag}>`,
            rawClose:
              close != null && INLINE_CLOSE.test(close) && close.toLowerCase() === `</${tag}>`
                ? close
                : `</${tag}>`,
            pid: Number.isFinite(pid) && pid > 0 ? pid : ++pairSeq,
          };
        },
      },
    ],
    toDOM: (mark) => [
      tag,
      {
        'data-raw-open': mark.attrs.rawOpen as string,
        'data-raw-close': mark.attrs.rawClose as string,
        'data-pid': String(mark.attrs.pid),
      },
      0,
    ],
    parseMarkdown: {
      match: (node) => node.type === 'prosaHtmlTag' && node.tag === tag,
      runner: (state, node, markType) => {
        state.openMark(markType, { rawOpen: node.rawOpen, rawClose: node.rawClose, pid: node.pid });
        state.next(node.children);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === `html_${tag}`,
      runner: (state, mark) => {
        state.withMark(mark, 'prosaHtmlTag', undefined, {
          tag,
          rawOpen: mark.attrs.rawOpen,
          rawClose: mark.attrs.rawClose,
          pid: mark.attrs.pid,
        });
      },
    },
  }));

export const htmlKbdMark = makeHtmlTagMark('kbd');
export const htmlSubMark = makeHtmlTagMark('sub');
export const htmlSupMark = makeHtmlTagMark('sup');

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
