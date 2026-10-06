/**
 * Markdown → HTML for the clipboard's rich-text flavor (#63, «Копировать для
 * Word»). Semantic tags only — h1–h6, strong/em, lists, tables, pre/code —
 * which Word, Outlook and the web mailers map onto their native styles on
 * paste.
 *
 * Raw HTML in the source is dropped (no allowDangerousHtml): same
 * whitelist-first stance as the editor's own HTML handling (#61), and it
 * keeps arbitrary markup out of other people's documents. Local image paths
 * stay as-is — Word cannot resolve them, the known v1 limitation.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

export function markdownToHtml(markdown: string): string {
  const body = String(processor.processSync(markdown));
  // Word reads the clipboard HTML as a standalone document — give it the
  // charset so Cyrillic survives the trip
  return `<html><head><meta charset="utf-8"></head><body>\n${body}</body></html>`;
}
