/**
 * Printing (#24 → #135): the document is re-rendered from its markdown
 * source into a hidden #print-root — never the live screen, whose chrome,
 * panels and zoom have no business on paper — and then handed to the
 * platform through TWO commands: «Сохранить в PDF…» (Ctrl+Shift+P —
 * Windows writes a silent PDF via WebView2 PrintToPdf with the path from
 * a Save dialog; macOS/Linux reuse the system print sheet) and «Печать…»
 * (Ctrl+P — the real dialog: WebView2 ShowPrintUI on Windows, the system
 * print sheet on macOS/Linux).
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
      // #137: callouts print as semantic blockquotes with a bold title
      // lead — same shape as the Copy-for-Word pipeline
      prosaCallout: (
        state: { all: (node: unknown) => unknown[] },
        node: { children?: unknown[] },
      ) => ({
        type: 'element',
        tagName: 'blockquote',
        properties: {},
        children: state.all(node),
      }),
      prosaCalloutTitle: (
        state: { all: (node: unknown) => unknown[] },
        node: { children?: unknown[] },
      ) =>
        (node.children?.length ?? 0) === 0
          ? { type: 'text', value: '' }
          : {
              type: 'element',
              tagName: 'p',
              properties: {},
              children: [
                {
                  type: 'element',
                  tagName: 'strong',
                  properties: {},
                  children: state.all(node),
                },
              ],
            },
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

/** #134: the honest wording follows the platform's actual pipeline —
 *  Windows saves a silent PDF via the Save dialog, macOS/Linux open the
 *  system print sheet, browser dev gets the browser dialog. */
export function printIsWindowsPipeline(): boolean {
  return inTauri && isWindows();
}

/** The failure wording for the «Сохранить в PDF…» command — must not lie
 *  under its own menu label (#134). */
export function savePdfErrorLabel(): string {
  return printIsWindowsPipeline() ? t('printErrorPdf') : t('printError');
}

/** The failure wording for the print command — the sheet/dialog path on
 *  every platform (#135). */
export function printErrorLabel(): string {
  return t('printError');
}

/** One print-family command at a time: a second Ctrl+P/Ctrl+Shift+P while
 * a dialog is up or an export is running would rebuild #print-root under
 * the running job — the first PDF could come out partial (review M1). */
let printing = false;

/** Render the hidden print copy from the source. An empty document (or
 *  front-matter-only) still renders — an empty #print-root prints a blank
 *  sheet: the owner's call (#135, 2026-10-16) is that every save/print
 *  command offers its dialog, exactly like «Сохранить» writes an empty
 *  file instead of refusing. */
async function renderPrintCopy(source: string): Promise<void> {
  const { body } = splitFrontMatter(source);
  const root = ensurePrintRoot();
  root.innerHTML = String(processor.processSync(body));
  await waitForImages(root);
}

/**
 * «Сохранить в PDF…» (Ctrl+Shift+P, #135). Windows writes a silent PDF
 * through the Save dialog (PrintToPdf); macOS/Linux hand the job to the
 * system print sheet (its «Save as PDF» / «Print to File» does the rest);
 * browser dev gets the browser dialog. `suggestedName` seeds the Save
 * dialog's file name on Windows.
 */
export async function savePdfDocument(source: string, suggestedName: string): Promise<void> {
  if (printing) return;
  printing = true;
  try {
    await renderPrintCopy(source);

    if (!inTauri) {
      window.print(); // plain browser (dev): the browser print dialog
      return;
    }

    const reportError = (err: unknown): void => {
      void message(`${savePdfErrorLabel()}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
    };

    if (printIsWindowsPipeline()) {
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
  } finally {
    printing = false;
  }
}

/**
 * «Печать…» (Ctrl+P, #135): the real print dialog — Windows opens the
 * WebView2 browser-style print UI (printer picker, preview) over the print
 * copy; macOS/Linux open the system print sheet; browser dev gets the
 * browser dialog. The owner's call: Ctrl+P is the print muscle memory and
 * must open a dialog, not save a file.
 */
export async function printSheetDocument(source: string): Promise<void> {
  if (printing) return;
  printing = true;
  try {
    await renderPrintCopy(source);

    if (!inTauri) {
      window.print(); // plain browser (dev): the browser print dialog
      return;
    }

    const reportError = (err: unknown): void => {
      void message(`${printErrorLabel()}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
    };

    try {
      await invoke(printIsWindowsPipeline() ? 'show_print_ui' : 'print_document');
    } catch (err) {
      reportError(err);
    }
  } finally {
    printing = false;
  }
}
