/**
 * Printing (#24): the document is re-rendered from its markdown source
 * into a hidden #print-root — never the live screen, whose chrome, panels
 * and zoom have no business on paper — and then handed to the platform:
 * Windows writes a silent PDF via WebView2 PrintToPdf (path from a Save
 * dialog), macOS/Linux open the system print sheet.
 *
 * The pipeline mirrors markdown-html.ts (контур A — the same structural
 * rules, the same inline-HTML whitelist from raw-html.ts) with
 * print-specific presentation: block HTML renders as code (like the
 * editor's html-block atom), image paths resolve through the asset
 * protocol exactly like the display layer (displaySrc). Front-matter is
 * metadata, not content — skipped, as in Copy-for-Word (#63).
 *
 * Approach informed by Markpad 2.8.4 (BSD-3) — see src-tauri/src/print.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import { message, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { prosaPairPlugin, prosaHtmlTagHandler } from './markdown-html';
import { displaySrc } from './editor/image-assets';
import { splitFrontMatter } from './frontmatter';
import { t } from './i18n';

const inTauri = '__TAURI_INTERNALS__' in window;

/** Rewrites <img> src through displaySrc — the print copy resolves
 * relative paths to the asset protocol exactly like the editor's display
 * layer, so `![](assets/x.png)` shows its pixels on paper. Also strips
 * exotic link schemes (`javascript:` and friends never belong on paper;
 * http/https/mailto and scheme-less hrefs stay). */
const printImages: Plugin = () => (tree) => {
  const walk = (node: unknown): void => {
    if (node && typeof node === 'object') {
      const n = node as { tagName?: string; properties?: Record<string, unknown>; children?: unknown[] };
      if (n.tagName === 'img' && typeof n.properties?.src === 'string') {
        n.properties.src = displaySrc(n.properties.src);
      }
      if (n.tagName === 'a' && typeof n.properties?.href === 'string') {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(n.properties.href)?.[1]?.toLowerCase();
        if (scheme && scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
          delete n.properties.href;
        }
      }
      n.children?.forEach(walk);
    }
  };
  walk(tree);
};

// handlers mirror markdown-html.ts with print-only differences:
// prosaHtmlBlock becomes a code block (the editor shows block HTML as
// code too — silently dropping a user's content would print a lie), and
// leftover inline html (non-whitelisted tags, which the editor keeps as
// literal text) prints as that literal text for the same reason;
// images/links are rewritten afterwards by printImages
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(prosaPairPlugin)
  .use(remarkRehype, {
    handlers: {
      prosaHtmlTag: prosaHtmlTagHandler,
      prosaHtmlBlock: (
        _state: unknown,
        node: { value?: string },
      ) => ({
        type: 'element',
        tagName: 'pre',
        properties: { 'data-html-block': '' },
        children: [
          {
            type: 'element',
            tagName: 'code',
            properties: {},
            children: [{ type: 'text', value: node.value ?? '' }],
          },
        ],
      }),
      html: (_state: unknown, node: { value?: string }) => ({ type: 'text', value: node.value ?? '' }),
    },
  } as Parameters<typeof remarkRehype>[0])
  .use(printImages)
  .use(rehypeStringify);

/** The hidden print copy of the document; rebuilt on every print. */
function ensurePrintRoot(): HTMLElement {
  let root = document.getElementById('print-root');
  if (root === null) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.append(root);
  }
  root.replaceChildren();
  return root;
}

/** Images must be decoded before printing — an unloaded <img> prints as a
 * blank box (Markpad's lesson). Each image resolves on load or error; a
 * dead remote image gets an 8 s cap so one broken link cannot hang the
 * print forever. */
function waitForImages(root: HTMLElement): Promise<void> {
  const pending = Array.from(root.querySelectorAll('img'))
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
          window.setTimeout(resolve, 8000);
        }),
    );
  return Promise.all(pending).then(() => undefined);
}

function isWindows(): boolean {
  return /Windows/i.test(navigator.userAgent);
}

/** One print at a time: a second Ctrl+P while the Save dialog is up or
 * PrintToPdf is running would rebuild #print-root under the running
 * export — the first PDF could come out partial (review M1). */
let printing = false;

/**
 * Print the given document. `suggestedName` seeds the Save dialog's file
 * name on Windows. Empty documents (nothing after the front-matter) print
 * nothing — a silent no-op, like an empty Copy-for-Word.
 */
export async function printDocument(source: string, suggestedName: string): Promise<void> {
  if (printing) return;
  printing = true;
  try {
    await printOnce(source, suggestedName);
  } finally {
    printing = false;
  }
}

async function printOnce(source: string, suggestedName: string): Promise<void> {
  const { body } = splitFrontMatter(source);
  if (!body.trim()) return;
  const root = ensurePrintRoot();
  root.innerHTML = String(processor.processSync(body));
  await waitForImages(root);

  if (!inTauri) {
    window.print(); // plain browser (dev): the browser print dialog
    return;
  }

  const reportError = (err: unknown): void => {
    void message(`${t('printError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
  };

  if (isWindows()) {
    const defaultName = suggestedName.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') + '.pdf';
    const path = await saveFileDialog({
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (path === null) return; // cancelled — nothing to print
    try {
      await invoke('print_to_pdf', { path });
    } catch (err) {
      reportError(err);
    }
  } else {
    try {
      await invoke('print_document');
    } catch (err) {
      reportError(err);
    }
  }
}
