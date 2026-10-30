import { storageGet, storageSet } from './storage';

/**
 * Recent documents (#96 start screen; the storage is shared with the
 * future «Недавние» menu #97 — one list, many surfaces).
 *
 * Plain localStorage through the #103 storage wrapper, capped, newest
 * first, deduped by path. A path that failed to open again is dropped
 * (removeRecent) so a deleted/moved file disappears after one honest
 * attempt instead of haunting the list.
 */

export interface RecentEntry {
  path: string;
  ts: number;
}

const KEY = 'prosa.recent';
const CAP = 10;

function read(): RecentEntry[] {
  try {
    const raw: unknown = JSON.parse(storageGet(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is RecentEntry =>
          typeof e === 'object' && e !== null && typeof (e as RecentEntry).path === 'string',
      )
      // QA rc.3: CAP действовал только на запись — storage, переживший старые
      // версии или правку руками, показывался длиннее десяти (меню «Файл»)
      .slice(0, CAP);
  } catch {
    return [];
  }
}

function write(entries: RecentEntry[]): void {
  storageSet(KEY, JSON.stringify(entries.slice(0, CAP)));
}

export function listRecent(): RecentEntry[] {
  return read();
}

export function addRecent(path: string): void {
  if (!path) return;
  // case-insensitive key: on Windows C:\A.md and c:\a.md are one file
  // (review MINOR); the stored entry keeps its original casing
  const key = path.toLowerCase();
  const rest = read().filter((e) => e.path.toLowerCase() !== key);
  write([{ path, ts: Date.now() }, ...rest]);
}

export function removeRecent(path: string): void {
  const key = path.toLowerCase();
  write(read().filter((e) => e.path.toLowerCase() !== key));
}
