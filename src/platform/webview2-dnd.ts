// WebView2 (the Tauri shell on Windows): `dragDropEnabled: false` makes wry
// RevokeDragDrop the OLE drop target Chromium's internal drag loop depends on
// and register its own CF_HDROP-only target (tauri#14373 and wry sources).
// Consequence, verified live (issue #13): a drag that page code "touches" —
// any dataTransfer write or custom drag image in a dragstart handler — is
// promoted to the full OLE DoDragDrop path and dies silently (dragstart and
// dragend fire, not a single dragover/drop arrives), after which WebView2
// rejects every following drag until the app restarts. Drags the page never
// touches stay on a light in-process path and work.
//
// Workaround: from the engine's point of view every drag must look untouched.
// Writes into DataTransfer go to a shadow store that only page-side readers
// see (prosemirror-view moves blocks via `view.dragging` and re-reads what it
// wrote; CodeMirror round-trips the same way), and during dragstart the
// `dataTransfer` getter hands out a detached synthetic object so the engine's
// own data store is never even accessed. Reads during dragover/drop are
// unaffected — they get the real object. Scoped to the Tauri WebView2 shell;
// plain browsers keep native behaviour. No wry release fixes this yet
// (checked through wry 0.57.0, 2026-10-03).
//
// Scoped since 0.1.8-rc.2: only DataTransfers handed out by drag events (the
// patched DragEvent.dataTransfer getter below marks them in a WeakSet) get the
// shadow treatment. Copy/cut events reach their DataTransfer through the
// untouched ClipboardEvent.clipboardData getter, stay unmarked and write to
// the real OS clipboard — the previous global shadow had silenced Ctrl+C
// entirely (prosemirror/CodeMirror preventDefault the native copy and write
// via setData) and made Ctrl+X delete the text without copying it.

export function applyWebView2DragFix(): void {
  if (!('__TAURI_INTERNALS__' in window)) return;
  if (!/Windows/.test(navigator.userAgent)) return;

  const proto = DataTransfer.prototype;
  const shadow = new WeakMap<DataTransfer, Record<string, string>>();
  const store = (dt: DataTransfer): Record<string, string> => {
    let s = shadow.get(dt);
    if (!s) {
      s = {};
      shadow.set(dt, s);
    }
    return s;
  };

  const real = {
    setData: Object.getOwnPropertyDescriptor(proto, 'setData')?.value as
      | ((this: DataTransfer, format: string, data: string) => void)
      | undefined,
    clearData: Object.getOwnPropertyDescriptor(proto, 'clearData')?.value as
      | ((this: DataTransfer, format?: string) => void)
      | undefined,
    getData: Object.getOwnPropertyDescriptor(proto, 'getData')?.value as
      | ((this: DataTransfer, format: string) => string)
      | undefined,
    types: Object.getOwnPropertyDescriptor(proto, 'types')?.get,
    effectAllowed: Object.getOwnPropertyDescriptor(proto, 'effectAllowed'),
  };

  // drag-event DataTransfers — see the header note; copy/cut stay unmarked.
  // Note the shadow applies to the WHOLE drag lifecycle: the getter below
  // also marks the REAL object handed out on dragover/dragenter/drop, not
  // just the dragstart synthetic — only during those phases, never for
  // clipboard events.
  const dragData = new WeakSet<DataTransfer>();

  proto.setData = function (this: DataTransfer, format: string, data: string): void {
    if (!dragData.has(this) && real.setData) {
      real.setData.call(this, format, data);
      return;
    }
    store(this)[String(format).toLowerCase()] = String(data);
  };

  proto.clearData = function (this: DataTransfer, format?: string): void {
    if (!dragData.has(this) && real.clearData) {
      real.clearData.call(this, format);
      return;
    }
    if (format === undefined) shadow.delete(this);
    else delete store(this)[String(format).toLowerCase()];
  };

  proto.getData = function (this: DataTransfer, format: string): string {
    const key = String(format).toLowerCase();
    const own = shadow.get(this);
    if (own && key in own) return own[key];
    if (real.getData) {
      try {
        return real.getData.call(this, format);
      } catch {
        /* protected mime type — fall through */
      }
    }
    return '';
  };

  if (real.types) {
    Object.defineProperty(proto, 'types', {
      get(this: DataTransfer): readonly string[] {
        const own = shadow.get(this);
        const engine = real.types?.call(this) ?? [];
        return own ? [...new Set([...Object.keys(own), ...engine])] : engine;
      },
      configurable: true,
    });
  }

  if (real.effectAllowed?.get && real.effectAllowed.set) {
    Object.defineProperty(proto, 'effectAllowed', {
      get(this: DataTransfer): string {
        return shadow.get(this)?.['effectallowed'] ?? real.effectAllowed!.get!.call(this);
      },
      set(this: DataTransfer, v: string): void {
        if (!dragData.has(this)) {
          real.effectAllowed!.set!.call(this, v);
          return;
        }
        store(this)['effectallowed'] = v;
      },
      configurable: true,
    });
  }

  // A custom drag image is decoration; skipping it costs nothing and avoids
  // feeding WebView2 anything during the fragile dragstart window.
  proto.setDragImage = function (): void {
    /* intentionally blank */
  };

  // Even a read of the engine's `event.dataTransfer` inside dragstart can
  // promote the drag onto the broken OLE path, so for dragstart only, hand
  // out a detached synthetic DataTransfer: handlers see the full API (backed
  // by the shadow store above), the engine sees nothing. dragover/drop keep
  // the real object — reads there are harmless and carry real drop data.
  // Every object that passes through here is marked as drag-related, which
  // is what scopes the setData/clearData shadow above.
  const dtDesc = Object.getOwnPropertyDescriptor(DragEvent.prototype, 'dataTransfer');
  if (dtDesc?.get) {
    const synthetic = new WeakMap<DragEvent, DataTransfer>();
    Object.defineProperty(DragEvent.prototype, 'dataTransfer', {
      get(this: DragEvent): DataTransfer | null {
        if (this.type === 'dragstart') {
          let dt = synthetic.get(this);
          if (!dt) {
            dt = new DataTransfer();
            synthetic.set(this, dt);
          }
          dragData.add(dt);
          return dt;
        }
        const dt = dtDesc.get!.call(this);
        if (dt) dragData.add(dt);
        return dt;
      },
      configurable: true,
    });
  }
}
