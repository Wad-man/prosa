import { convertFileSrc } from '@tauri-apps/api/core';
import { exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { message } from '@tauri-apps/plugin-dialog';
import { t } from '../i18n';

/**
 * #68 (durable images): two halves of one policy — the markdown source is
 * the single truth, the filesystem serves the pixels.
 *
 *  - display: a relative `![](assets/x.png)` resolves against the document's
 *    folder and loads through the Tauri asset protocol (enabled in
 *    tauri.conf.json). The rewrite happens ONLY in the DOM display layer
 *    (Crepe's `proxyDomURL`), never in the ProseMirror model — the
 *    serializer keeps writing the original markdown string, so the
 *    round-trip stays byte-for-byte (#33 lossless).
 *  - paste/drop: image bytes go to an `assets/` subfolder next to the
 *    document (Typora convention) and the model receives the relative
 *    link — the ephemeral `blob:` URLs the stock uploader wrote into files
 *    died with the WebView session they came from.
 *
 * In a plain browser (npm run dev, no Tauri shell) there is no document
 * folder and no asset protocol: display keeps the raw src and pastes fall
 * back to the stock blob URL — dev-only degradation.
 */

const inTauri = '__TAURI_INTERNALS__' in window;

/** Where the current document lives, supplied by main.ts. */
export interface ImageDocContext {
  /** Directory of the current document file (null while untitled). */
  getDocDir: () => string | null;
  /**
   * Persist an untitled document before the first image can land next to
   * it (Save As dialog); resolves false when the user declines/cancels.
   */
  ensureSaved: () => Promise<boolean>;
}

let docContext: ImageDocContext | null = null;

export function setImageContext(ctx: ImageDocContext): void {
  docContext = ctx;
}

/** Join a document directory and a relative path on Windows/POSIX style dirs. */
function joinFsPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`;
}

/** An absolute filesystem path (drive letter, UNC or POSIX root). */
function isAbsoluteFsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/**
 * The display URL for a markdown image src (`proxyDomURL` for both Crepe
 * image components). Web/data/blob URLs pass through untouched; filesystem
 * paths go through the asset protocol (spaces and Cyrillic encode on the
 * way). Everything else — a relative path without a document folder, a
 * plain browser — is returned as-is: the broken-image placeholder (#65) is
 * the honest rendering there.
 */
export function displaySrc(raw: string): string {
  if (!inTauri) return raw;
  if (/^(?:https?:|data:|blob:|asset:)/i.test(raw)) return raw;
  const dir = docContext?.getDocDir() ?? null;
  const abs = isAbsoluteFsPath(raw) ? raw : dir !== null ? joinFsPath(dir, raw) : null;
  return abs !== null ? convertFileSrc(abs) : raw;
}

/** Extension for an image MIME type, with dot; '.png' as the least-wrong guess. */
function extFromType(type: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
    'image/x-icon': '.ico',
  };
  return known[type] ?? '.png';
}

/**
 * A name that survives round-trip: strip filesystem-illegal characters and
 * SPACES (a bare CommonMark destination cannot contain them — the link we
 * insert must re-parse on reopen without the `<…>` form), keep Cyrillic,
 * cap length. Windows-legal by construction.
 */
function sanitizeName(name: string, type: string): string {
  let base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
  base = base.replace(/[. _]+$/, '');
  if (base.length > 100) base = base.slice(0, 100);
  if (base === '' || base === '.') base = 'image';
  if (!/\.[a-z0-9]+$/i.test(base)) base += extFromType(type);
  return base;
}

/**
 * `base`, `base-2`, `base-3`… — the first free name in the assets/ folder.
 * A failed existence check counts as free: the write below surfaces the
 * real error if the folder is unreachable.
 */
async function freeName(assetsDir: string, base: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : base.replace(/(\.[^.]+)$/, `-${i}$1`);
    try {
      if (!(await exists(joinFsPath(assetsDir, candidate)))) return candidate;
    } catch {
      return candidate;
    }
  }
  return base.replace(/(\.[^.]+)$/, `-${Date.now()}$1`);
}

/**
 * Make sure pasted images have a place to live: an untitled document is
 * offered a Save As first (once per batch). False = the user declined —
 * the insert is aborted, nothing lands in the file.
 */
export async function ensureImageTarget(): Promise<boolean> {
  if (!inTauri) return true;
  if ((docContext?.getDocDir() ?? null) !== null) return true;
  return await (docContext?.ensureSaved() ?? Promise.resolve(false));
}

/**
 * Write pasted/dropped image bytes into `assets/` next to the document and
 * return the relative markdown link (`assets/имя.png`). Null = abort (a
 * write error shows its own message; a dead link is never written).
 */
export async function writeImageFile(file: File): Promise<string | null> {
  if (!inTauri) return URL.createObjectURL(file);
  const dir = docContext?.getDocDir() ?? null;
  if (dir === null) return null;
  try {
    const assetsDir = joinFsPath(dir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const name = await freeName(assetsDir, sanitizeName(file.name, file.type));
    await writeFile(joinFsPath(assetsDir, name), new Uint8Array(await file.arrayBuffer()));
    // forward slashes: the canonical markdown form on every platform
    return `assets/${name}`;
  } catch (err) {
    void message(`${t('imgSaveError')}: ${String(err)}`, { title: 'ProsaMD', kind: 'error' });
    return null;
  }
}
