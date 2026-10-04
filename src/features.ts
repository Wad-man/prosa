/**
 * Feature flags for built-in core capabilities (#21).
 *
 * Deliberately NOT a plugin mechanism: plain booleans for features the core
 * itself ships with, persisted the same way as theme/lang (localStorage).
 * No manifests, no dynamic loading — the plugin platform is a separate,
 * future system (PLUGIN_SYSTEM.md in prosa-docs). A flag must gate a
 * finished core capability, never half-load optional code.
 *
 * Flags are read at window startup; there is no live cross-window sync on
 * purpose — doc-* windows are independent documents, exactly like theme and
 * language today.
 */

export type FeatureId = 'toc';

const KEY = 'prosa.features';

function readFlags(): Partial<Record<FeatureId, boolean>> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (typeof raw === 'object' && raw !== null) return raw as Partial<Record<FeatureId, boolean>>;
  } catch {
    // corrupted storage — fall through to defaults
  }
  return {};
}

export function isFeatureEnabled(id: FeatureId): boolean {
  return readFlags()[id] === true;
}

export function setFeatureEnabled(id: FeatureId, enabled: boolean): void {
  const flags = readFlags();
  flags[id] = enabled;
  localStorage.setItem(KEY, JSON.stringify(flags));
  // same-window notification only (see the header comment on sync)
  window.dispatchEvent(new CustomEvent('prosa-features-changed'));
}

export function onFeaturesChanged(cb: () => void): void {
  window.addEventListener('prosa-features-changed', cb);
}
