/**
 * Local mock of `openclaw/plugin-sdk/plugin-entry` for unit tests in the secr
 * monorepo (where the real `openclaw` package isn't installed). Mirrors the
 * runtime contract: passes through the entry def with a brand marker.
 */
export function definePluginEntry<T>(opts: T): T & { __openclawPlugin: true } {
  return Object.assign({}, opts as object, { __openclawPlugin: true as const }) as any;
}
