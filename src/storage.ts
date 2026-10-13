// Safe localStorage access (#103). WKWebView on a custom scheme
// (tauri://localhost) may throw SecurityError on merely touching
// `localStorage`; one such throw during module eval used to kill the whole
// ES-module graph. Every access goes through here: the first failure marks
// storage unavailable for the rest of the session and reads/writes fall back
// to an in-memory map (works, just doesn't persist). Never throws.
const memory = new Map<string, string>();
let available = true;

function backend(): Storage | null {
  if (!available) return null;
  try {
    return window.localStorage;
  } catch {
    available = false;
    return null;
  }
}

function attempt<T>(op: (s: Storage) => T): T | undefined {
  const s = backend();
  if (!s) return undefined;
  try {
    return op(s);
  } catch {
    available = false;
    return undefined;
  }
}

export function storageGet(key: string): string | null {
  if (available) {
    const v = attempt((s) => s.getItem(key));
    if (available) return v ?? null;
  }
  return memory.get(key) ?? null;
}

export function storageSet(key: string, value: string): void {
  if (available) {
    attempt((s) => s.setItem(key, value));
    if (available) return;
  }
  memory.set(key, value);
}

export function storageRemove(key: string): void {
  if (available) {
    attempt((s) => s.removeItem(key));
    if (available) return;
  }
  memory.delete(key);
}
