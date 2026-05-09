import type { PluginState } from "./state.js";

/**
 * before_message_write: redact known secret values from agent messages
 * before they're written to the session log / persistence layer.
 *
 * Defence-in-depth: agents shouldn't echo secrets, but if a model regurgitates
 * a value it read via secr.materialize_env / secr.get_secret, we strip it
 * before the message is written down. Cannot prevent transmission (the model
 * has already produced the text), but prevents persistence and downstream
 * logging.
 *
 * Trade-offs:
 *   - Only redacts values >= 8 chars (PluginState.MIN_REDACT_VALUE_LEN) to
 *     avoid false positives on short values that'd corrupt unrelated text.
 *   - Cache TTL is 5min; new secrets aren't redacted until refresh.
 *   - Walks the message recursively; only string leaves are inspected.
 */
export function buildBeforeMessageWriteHook(state: PluginState) {
  return async (
    event: { message: any; sessionKey?: string; agentId?: string },
    ctx: { agentId?: string; sessionKey?: string; pluginConfig?: { enforceGateway?: boolean } },
  ): Promise<{ block?: boolean; message?: any } | void> => {
    const cfg = ctx.pluginConfig;
    if (cfg && cfg.enforceGateway === false) return;

    const values = await state.getRedactionValues();
    if (values.size === 0) return;

    const { message, modified } = redactInPlace(event.message, values);
    if (!modified) return;

    if (process.env.SECR_PLUGIN_DEBUG) {
      try {
        const fs = await import("node:fs");
        fs.appendFileSync("/tmp/secr-plugin-debug.log",
          JSON.stringify({
            t: new Date().toISOString(),
            phase: "before_message_write",
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
            redactionCount: values.size,
          }) + "\n");
      } catch { /* never throw */ }
    }

    return { message };
  };
}

/**
 * Walks an arbitrary value recursively; replaces every occurrence of any
 * value in `values` with `[REDACTED]` in string leaves. Returns the new
 * value plus a flag indicating whether anything changed.
 */
function redactInPlace(input: unknown, values: Set<string>): { message: unknown; modified: boolean } {
  let modified = false;

  function walk(node: unknown): unknown {
    if (node == null) return node;
    if (typeof node === "string") {
      let out = node;
      for (const v of values) {
        if (out.includes(v)) {
          out = out.split(v).join("[REDACTED]");
          modified = true;
        }
      }
      return out;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        obj[k] = walk(v);
      }
      return obj;
    }
    return node;
  }

  return { message: walk(input), modified };
}
