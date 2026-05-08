import type { PluginState } from "./state.js";
import type {
  BeforeToolCallEvent,
  BeforeToolCallResult,
  PluginContext,
} from "./types.js";

const SENSITIVE_PARAM_KEYS = new Set([
  "token", "password", "secret", "key", "apiKey", "api_key",
  "authorization", "cookie", "value",
]);

function redactParameters(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = SENSITIVE_PARAM_KEYS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Build the before_tool_call hook handler. Returns block / requireApproval
 * decisions back to OpenClaw based on our MCP gateway evaluation.
 *
 * Decision tree:
 *   1. Skip secr.* tools (we manage those ourselves; otherwise infinite loops).
 *   2. Skip if enforceGateway is false in plugin config.
 *   3. Lazy-init broker + gateway (network on first call only).
 *   4. checkToolAccess → if denied, return { block: true, blockReason }.
 *   5. If requiresApproval → check active grant; if granted, allow; otherwise
 *      return requireApproval to surface OpenClaw's native approval UI.
 *   6. Rate limit check → block if exceeded.
 *   7. Otherwise allow — fire-and-forget audit report happens after_tool_call.
 *
 * Errors during gateway evaluation fail OPEN (do not block) — secr's role is
 * defence-in-depth, not the only line of defence. OpenClaw's own checks still
 * apply. We log the error via console but never throw to OpenClaw.
 */
export function buildToolCallHook(state: PluginState) {
  return async (
    event: BeforeToolCallEvent,
    ctx: PluginContext,
  ): Promise<BeforeToolCallResult | void> => {
    // Diagnostic: dump shapes so we can validate types.ts against the real
    // OpenClaw contract. Set SECR_PLUGIN_DEBUG=1 to enable; writes JSONL to
    // /tmp/secr-plugin-debug.log.
    if (process.env.SECR_PLUGIN_DEBUG) {
      try {
        const fs = await import("node:fs");
        const line = JSON.stringify({
          t: new Date().toISOString(),
          event_keys: Object.keys(event ?? {}),
          ctx_keys: Object.keys(ctx ?? {}),
          toolName: (event as any)?.toolName,
          params_type: typeof (event as any)?.params,
          params_isArray: Array.isArray((event as any)?.params),
          pluginConfig: (ctx as any)?.pluginConfig,
          ctx_sample: {
            agentId: (ctx as any)?.agentId,
            sessionId: (ctx as any)?.sessionId,
            runId: (ctx as any)?.runId,
            jobId: (ctx as any)?.jobId,
          },
          event_sample: {
            runId: (event as any)?.runId,
            toolCallId: (event as any)?.toolCallId,
            paramKeys: (event as any)?.params && typeof (event as any).params === "object"
              ? Object.keys((event as any).params)
              : null,
          },
        }) + "\n";
        fs.appendFileSync("/tmp/secr-plugin-debug.log", line);
      } catch {
        // never throw from debug
      }
    }

    const cfg = ctx.pluginConfig;
    if (cfg && cfg.enforceGateway === false) return;

    const { toolName, params } = event;

    // Don't gate our own helper tools — they have their own internal checks.
    if (toolName.startsWith("secr.")) return;

    let gateway;
    try {
      gateway = await state.getGateway();
    } catch (err: any) {
      console.warn(`[secr] gateway init failed, allowing tool '${toolName}':`, err?.message ?? err);
      return; // fail open
    }

    const access = gateway.checkToolAccess(toolName as any);
    if (!access.allowed) {
      gateway.reportToolCall({
        toolName,
        parameters: redactParameters(params),
        status: "denied",
        errorMessage: access.reason,
      });
      return {
        block: true,
        blockReason: access.reason ?? `Tool '${toolName}' is denied by secr gateway policy`,
      };
    }

    if (access.requiresApproval) {
      // Check whether an admin has already approved a recent attempt.
      const grant = await gateway.checkApprovalGrant(toolName);
      if (grant.granted) {
        // Atomic consume succeeded — proceed.
        return;
      }

      // Surface OpenClaw's native approval UI. Also record the attempt in
      // secr's pending queue so admins can decide there too if the runtime UI
      // isn't visible to the operator (e.g. headless deployments).
      gateway.reportToolCall({
        toolName,
        parameters: redactParameters(params),
        status: "approval_required",
      });

      return {
        requireApproval: {
          title: `Approval required: ${toolName}`,
          description:
            grant.note
              ? `secr gateway requires approval. Last note: ${grant.note}`
              : `secr gateway requires approval before this tool can run. ` +
                `Either approve here, or visit the secr dashboard's Pending Approvals queue.`,
          severity: "warning",
          timeoutMs: 10 * 60_000, // 10 minutes — matches secr grant TTL
          timeoutBehavior: "deny",
          pluginId: "secr",
          onResolution: async (decision) => {
            // OpenClaw-side allow: the tool will run; success/error is reported
            // post-execution. We don't double-record here.
            if (decision === "allow-once" || decision === "allow-always") return;

            // OpenClaw-side deny / timeout / cancelled — record in secr audit.
            gateway.reportToolCall({
              toolName,
              parameters: redactParameters(params),
              status: "denied",
              errorMessage: `OpenClaw approval ${decision}`,
            });
          },
        },
      };
    }

    const rate = gateway.checkRateLimit();
    if (!rate.allowed) {
      gateway.reportToolCall({
        toolName,
        parameters: redactParameters(params),
        status: "denied",
        errorMessage: `Rate limit exceeded; retry after ${rate.retryAfterSeconds}s`,
      });
      return {
        block: true,
        blockReason: `secr rate limit exceeded; retry after ${rate.retryAfterSeconds} seconds`,
      };
    }

    // Allowed. The post-execution success/error report would ideally come
    // from an `after_tool_call` hook; the OpenClaw runtime fires that with
    // outcome+duration. Until we wire that hook, we report success here as
    // a "started" marker.
    gateway.reportToolCall({
      toolName,
      parameters: redactParameters(params),
      status: "success",
    });
  };
}
