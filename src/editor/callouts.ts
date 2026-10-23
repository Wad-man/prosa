// #137: Obsidian callouts (`> [!info] Title`). Part 1 of the issue is the
// byte bug: an unresolved `[!info]` at mdast level is plain TEXT, and
// remark-stringify escapes a bracket that could open a link reference —
// every save rewrote `> [!info]` into `> \[!info]`. Part 2 is the feature:
// a callout renders as a typed, colored box instead of a bare blockquote.
//
// Both parts close the same way, following the raw-html.ts pattern: a
// $remark transform upgrades the mdast BEFORE milkdown's parser sees it
// (a blockquote whose first paragraph opens with `[!type]`+optional
// `+`/`-` fold marker becomes a `prosaCallout` node), a PM node pair
// (`callout` + `callout_title` — underscore: a hyphen in a node name is a
// \W token inside content expressions) carries it in the model, and a
// custom remark-stringify handler writes the marker back VERBATIM — no
// bracket escaping, no lost bytes.
//
// Strict form only (like the raw-HTML whitelist): the marker must open
// the blockquote's first paragraph. A `[!info]` mid-quote or mid-text
// stays a blockquote/text and keeps the stock escaping — that is a
// different, honest L0 surface (#128 territory).
//
// Byte fidelity notes (verified against remark round-trips):
//  - the marker's trailing separator space rides INSIDE the title text
//    node (`[!info] Title` → marker + text ' Title'), because
//    mdast-util-to-markdown concatenates phrasing siblings without any
//    separator of its own;
//  - the lazy form `> [!info] Title\n> body` is ONE mdast paragraph with
//    an embedded \n. The transform splits it at the first newline and
//    records `joinedBody: true` on the callout; the serializer re-joins
//    the pieces through a bare '\n' text node (the same trick the stock
//    hardbreak serializer uses for inline breaks), keeping the file's
//    line structure. The blank-line form round-trips as two paragraphs
//    without the flag.
//  - the raw type spelling round-trips verbatim (`[!INFO]` stays
//    uppercase); rendering resolves it case-insensitively against the
//    canonical Obsidian kind table, unknown types render as `note` with
//    the raw spelling as the fallback title.
import { $node, $remark } from '@milkdown/kit/utils';

/** Minimal mdast shape this walk needs (remark keeps extra keys untouched). */
type MdNode = {
  type: string;
  value?: string | null;
  children?: MdNode[];
  position?: unknown;
  /** linkReference shape — only if a definition elsewhere made remark resolve the bracket into a reference node */
  identifier?: string;
  label?: string;
  referenceType?: string;
  /** prosaCallout props (this module's own mdast node) */
  calloutType?: string;
  fold?: Fold;
  joinedBody?: boolean;
};

/** `[!type]` + optional fold marker, exactly at the paragraph start. */
const MARKER_TEXT = /^\[!([A-Za-z0-9_-]+)\]([+-])?/;
const MARKER_LABEL = /^!([A-Za-z0-9_-]+)$/;

/** Fold state as stored in the model and re-emitted after `]`. */
type Fold = 'none' | 'minus' | 'plus';

/**
 * Split the first paragraph's inline content at the first soft newline —
 * either a '\n' inside a text value (plain remark pipelines) or a break
 * NODE (milkdown's presets convert soft line breaks to inline break nodes
 * before app-level plugins run — verified against the live editor). The
 * break consumed here is re-emitted as a bare soft '\n' by the serializer:
 * a HARD-break flavor sitting exactly at the title/body join is a v1 L1
 * normalization ('  \n' / '\\\n' degrade to '\n').
 */
const splitTitleBody = (inlines: MdNode[]): { title: MdNode[]; body: MdNode[] | null } => {
  const title: MdNode[] = [];
  let body: MdNode[] | null = null;
  for (const child of inlines) {
    if (body) {
      body.push(child);
      continue;
    }
    if (child.type === 'break') {
      body = [];
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
      const at = child.value.indexOf('\n');
      if (at > 0) title.push({ type: 'text', value: child.value.slice(0, at) });
      const rest = child.value.slice(at + 1);
      body = rest ? [{ type: 'text', value: rest }] : [];
    } else {
      title.push(child);
    }
  }
  return { title, body };
};

/**
 * A blockquote becomes a callout when its FIRST paragraph opens with the
 * marker. Returns the replacement mdast node, or null to keep the
 * blockquote stock.
 */
const convertCallout = (bq: MdNode): MdNode | null => {
  const first = bq.children?.[0];
  if (!first || first.type !== 'paragraph' || !first.children?.length) return null;

  const head = first.children[0];
  let calloutType: string | null = null;
  let fold: Fold = 'none';
  let restHead = '';

  if (head.type === 'text' && typeof head.value === 'string') {
    const m = MARKER_TEXT.exec(head.value);
    if (m) {
      calloutType = m[1];
      fold = m[2] === '-' ? 'minus' : m[2] === '+' ? 'plus' : 'none';
      // keep the separator space inside the title text — see header notes
      restHead = head.value.slice(m[0].length);
    }
  } else if (head.type === 'linkReference') {
    const label = typeof head.label === 'string' ? head.label : head.identifier ?? '';
    const m = MARKER_LABEL.exec(label);
    if (m && head.referenceType === 'shortcut') calloutType = m[1];
  }
  if (!calloutType) return null;

  const inlines: MdNode[] = [];
  if (restHead) inlines.push({ type: 'text', value: restHead });
  inlines.push(...first.children.slice(1));
  const { title, body } = splitTitleBody(inlines);

  const restBlocks = bq.children?.slice(1) ?? [];
  return {
    type: 'prosaCallout',
    calloutType,
    fold,
    joinedBody: body !== null,
    children: [
      { type: 'prosaCalloutTitle', children: title },
      ...(body ? [{ type: 'paragraph', children: body, position: first.position }] : []),
      ...restBlocks,
    ],
    position: bq.position,
  };
};

/** The tree transform — reused by «Copy for Word» and print (markdown-html.ts). */
export const prosaCalloutTransform = (tree: MdNode): void => {
  const visit = (nodes: MdNode[]): void => {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.type === 'blockquote') {
        const converted = convertCallout(node);
        if (converted) nodes[i] = converted;
      }
      const current = nodes[i];
      if (current.children) visit(current.children);
    }
  };
  if (tree.children) visit(tree.children);
};

/** Runs before rawHtmlTagger (registration order): raw-html's walk then
 * sees `prosaCallout` and treats its direct children as block content. */
export const calloutTagger = $remark('prosa-callouts', () => () => (tree: unknown) => {
  if (tree && typeof tree === 'object' && 'type' in tree) prosaCalloutTransform(tree as MdNode);
});

// ---------- the Obsidian kind table (rendering only — bytes ride above) ----------

export type CalloutKind = { id: string; label: string };

const KIND_ALIASES: Record<string, string> = {
  note: 'note',
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  info: 'info',
  todo: 'todo',
  tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote', cite: 'quote',
};

const KIND_LABELS: Record<string, string> = {
  note: 'Note', abstract: 'Abstract', info: 'Info', todo: 'To do', tip: 'Tip',
  success: 'Success', question: 'Question', warning: 'Warning', failure: 'Failure',
  danger: 'Danger', bug: 'Bug', example: 'Example', quote: 'Quote',
};

/** Resolve the raw spelling to a render kind; unknown types take the note
 * look with the raw spelling as the fallback title (Obsidian's behavior). */
export const calloutKind = (raw: string): CalloutKind => {
  const id = KIND_ALIASES[raw.toLowerCase()] ?? 'note';
  return { id, label: KIND_ALIASES[raw.toLowerCase()] ? KIND_LABELS[id] : raw };
};

// ---------- the ProseMirror model ----------

/**
 * The callout box. Two content holes: the title node first, body blocks
 * after (`block*` — `> [!info]` with no body is legal and round-trips).
 * `joinedBody` is the lazy-form fidelity flag (see header notes) — an
 * edit-path-only attr, DOM round-trips carry it through data-joined.
 */
export const calloutNode = $node('callout', () => ({
  group: 'block',
  content: 'callout_title block*',
  defining: true,
  attrs: {
    calloutType: { default: 'note', validate: 'string' },
    fold: { default: 'none', validate: 'string' },
    joinedBody: { default: false, validate: 'boolean' },
  },
  // PM's DOMOutputSpec allows exactly ONE content hole (0) and only as an
  // only child — so the box is FLAT: the title row renders through the
  // callout_title node's own toDOM, body blocks sit as direct children and
  // CSS separates them (.prosa-callout > :not(.prosa-callout-title))
  toDOM: (node) => {
    const kind = calloutKind(String(node.attrs.calloutType));
    return [
      'div',
      {
        class: 'prosa-callout',
        'data-callout': String(node.attrs.calloutType),
        'data-callout-kind': kind.id,
        'data-fold': String(node.attrs.fold),
        'data-joined': node.attrs.joinedBody ? '1' : '0',
        // the empty-title placeholder text (CSS reads it via :empty::before)
        style: `--callout-ph: ${kind.label}`,
      },
      0,
    ];
  },
  parseDOM: [
    {
      tag: 'div.prosa-callout',
      getAttrs: (dom) => {
        if (typeof dom === 'string') return {};
        const foldRaw = dom.getAttribute('data-fold');
        return {
          calloutType: dom.getAttribute('data-callout') ?? 'note',
          fold: foldRaw === 'minus' || foldRaw === 'plus' ? foldRaw : 'none',
          joinedBody: dom.getAttribute('data-joined') === '1',
        };
      },
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === 'prosaCallout',
    runner: (state, node, type) => {
      state
        .openNode(type, {
          calloutType: typeof node.calloutType === 'string' ? node.calloutType : 'note',
          fold: node.fold === 'minus' || node.fold === 'plus' ? node.fold : 'none',
          joinedBody: node.joinedBody === true,
        })
        .next(node.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      state.openNode('blockquote');
      state.openNode('paragraph');
      state.addNode('prosaCalloutMarker', undefined, undefined, {
        calloutType: node.attrs.calloutType,
        fold: node.attrs.fold,
      });
      // the title's inline content joins the marker inside one mdast
      // paragraph; the lazy form continues with a bare '\n' text node and
      // the first body paragraph's inlines — the stock paragraph splitting
      // would insert a blank `>` line the source never had
      const title = node.maybeChild(0);
      let offset = 0;
      if (title?.type.name === 'callout_title') {
        state.next(title.content);
        offset += title.nodeSize;
      }
      if (node.attrs.joinedBody) {
        const joined = node.maybeChild(title ? 1 : 0);
        if (joined?.type.name === 'paragraph') {
          state.addNode('text', undefined, '\n');
          state.next(joined.content);
          offset += joined.nodeSize;
        }
      }
      state.closeNode();
      if (offset < node.content.size) state.next(node.content.cut(offset));
      state.closeNode();
    },
  },
}));

/** The callout title line — heading-like inline container, editable in
 * place (formatted titles round-trip through the normal phrasing path).
 * Renders the whole title ROW (icon comes from CSS); the inner span keeps
 * the inline content addressable for the :empty placeholder. */
export const calloutTitleNode = $node('callout_title', () => ({
  content: 'inline*',
  defining: true,
  parseDOM: [
    {
      tag: 'div.prosa-callout-title',
      contentElement: (dom) => {
        if (typeof dom === 'string') return dom;
        return (dom.querySelector(':scope > .prosa-callout-title-text') as HTMLElement | null) ?? dom;
      },
    },
  ],
  toDOM: () => ['div', { class: 'prosa-callout-title' }, ['span', { class: 'prosa-callout-title-text' }, 0]],
  parseMarkdown: {
    match: (node) => node.type === 'prosaCalloutTitle',
    runner: (state, node, type) => {
      state.openNode(type).next(node.children).closeNode();
    },
  },
  toMarkdown: {
    // never reached standalone — the callout's runner consumes the title
    // child directly; a stray title outside a callout cannot serialize
    match: (node) => node.type.name === 'callout_title',
    runner: () => undefined,
  },
}));
