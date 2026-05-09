/**
 * @secr/openclaw-plugin — native OpenClaw plugin entry.
 *
 * Loaded by the OpenClaw runtime via `openclaw plugins install npm:@secr/openclaw-plugin`
 * (or `clawhub:secr` once published). The runtime injects the plugin SDK and
 * config; this module registers the tool-call gating hook + the secr.* tools
 * + the optional startup materializer.
 *
 * IMPORTANT: this module does not import from `openclaw/plugin-sdk` directly
 * because the runtime hasn't necessarily resolved that dep at typecheck time
 * inside the secr monorepo. The plugin entry contract is structurally typed —
 * `definePluginEntry` is a passthrough function provided by the runtime.
 *
 * If you're integrating against a vendored OpenClaw SDK, replace the local
 * `definePluginEntry` import with:
 *
 *   import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PluginState } from "./state.js";
import { buildToolCallHook, buildAfterToolCallHook } from "./tool-call-hook.js";
import { registerSecrTools } from "./tools.js";
import type { OpenClawPluginApi, PluginConfig } from "./types.js";

export default definePluginEntry<OpenClawPluginApi>({
  id: "secr",
  name: "secr — Secrets management & NHI governance",
  description:
    "Brokers credentials, enforces per-agent allowlists, and gates tool calls through the secr MCP gateway. " +
    "Set SECR_AGENT_TOKEN and add a `secr:` block to IDENTITY.md frontmatter.",

  register(api: OpenClawPluginApi) {
    // Tools, hooks, and config are registered in every mode — discovery mode
    // needs metadata visible to `openclaw plugins inspect`. Only HEAVY
    // operations (network/services) are gated to "full" mode below.
    const isFull = !api.registrationMode || api.registrationMode === "full";

    // Plugin config comes from `plugins.entries.secr.config` in
    // ~/.openclaw/openclaw.json (validated against our configSchema). The
    // OpenClaw runtime delivers it via ctx.pluginConfig in hooks; for
    // module-level setup we fall through to env-var defaults.
    const baseConfig: PluginConfig = {
      apiUrl: process.env.SECR_API_URL,
      identityPath: process.env.SECR_IDENTITY_PATH,
      tokenEnvVar: "SECR_AGENT_TOKEN",
      materializeOnStartup: false,
      enforceGateway: true,
    };

    const state = new PluginState(baseConfig);

    // Tool-call gating — allow/deny, rate limit, approval flow. Uses api.on()
    // which is the typed-plugin-hook entry; api.registerHook() is for the
    // InternalHookEvent shape (command/session events) and would not fire on
    // tool calls.
    api.on(
      "before_tool_call",
      buildToolCallHook(state),
      { priority: 100 },
    );

    // Pair: after_tool_call records the actual outcome (success/error + duration).
    // Without this we can only report "the tool was allowed to run", not what it did.
    api.on(
      "after_tool_call",
      buildAfterToolCallHook(state),
      { priority: 100 },
    );

    // Explicit secret-resolution tools the agent can invoke directly.
    registerSecrTools(api, state);

    // Optional: inject allowlisted secrets into process.env at startup.
    // Service is HEAVY (touches the secr API on start) — only register in full mode.
    if (isFull && baseConfig.materializeOnStartup && api.registerService) {
      api.registerService({
        name: "secr.materialize-on-startup",
        async start() {
          try {
            const broker = await state.getBroker();
            await broker.materializeEnv();
          } catch (err: any) {
            console.warn("[secr] materializeOnStartup failed:", err?.message ?? err);
          }
        },
      });
    }
  },
});

// Named exports for advanced callers / test harnesses.
export { PluginState } from "./state.js";
export { buildToolCallHook } from "./tool-call-hook.js";
export { registerSecrTools } from "./tools.js";
export type {
  PluginConfig,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  PluginContext,
  OpenClawPluginApi,
  PluginEntryDef,
} from "./types.js";
