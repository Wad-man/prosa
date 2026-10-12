/**
 * Markdown → HTML for the clipboard's rich-text flavor (#63, «Копировать для
 * Word»). Semantic tags only — h1–h6, strong/em, lists, tables, pre/code —
 * which Word, Outlook and the web mailers map onto their native styles on
 * paste.
 *
 * Raw HTML stays out (no allowDangerousHtml) with one carve-out (#61): the
 * same inline whitelist the editor renders — kbd/sub/sup pairs and `<br>`
 * variants — is paired here too and passes through as real tags, so «H₂O»
 * copies as subscript instead of a flat «H2O». Block-level HTML keeps being
 * dropped: arbitrary markup does not belong in other people's documents.
 * Local image paths stay as-is — Word cannot resolve them, the known v1
 * limitation.
 */
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { prosaRawHtmlTransform } from './editor/raw-html';

type MdTree = Parameters<typeof prosaRawHtmlTransform>[0];

const prosaPairPlugin: Plugin = () => (tree) => {
  prosaRawHtmlTransform(tree as MdTree);
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(prosaPairPlugin)
  .use(remarkRehype, {
    // paired whitelist tags → real elements; block HTML (prosaHtmlBlock)
    // drops OUT entirely — left to its unknown-type default it leaks into
    // the buffer as escaped visible text; non-whitelisted inline html is
    // unknown to rehype and drops the same way
    handlers: {
      prosaHtmlTag: (
        state: { all: (node: unknown) => unknown[] },
        node: { tag: string; children?: unknown[] },
      ) => ({
        type: 'element',
        tagName: node.tag,
        properties: {},
        children: state.all(node),
      }),
      prosaHtmlBlock: () => ({ type: 'text', value: '' }),
    },
  } as Parameters<typeof remarkRehype>[0])
  .use(rehypeStringify);

export function markdownToHtml(markdown: string): string {
  const body = String(processor.processSync(markdown));
  // Word reads the clipboard HTML as a standalone document — give it the
  // charset so Cyrillic survives the trip
  return `<html><head><meta charset="utf-8"></head><body>\n${body}</body></html>`;
}
