import { Type } from "@sinclair/typebox";
import type { PluginState } from "./state.js";
import type { OpenClawPluginApi, ToolExecuteResult } from "./types.js";

function textResult(text: string, isError = false): ToolExecuteResult {
  return { content: [{ type: "text", text }], isError };
}

export function registerSecrTools(api: OpenClawPluginApi, state: PluginState): void {
  // ─── secr.get_secret ─────────────────────────────────────────────────────
  api.registerTool({
    name: "secr.get_secret",
    description:
      "Resolve a single secret by key from secr. The agent's secretAllowlist is enforced server-side; non-allowlisted keys return an error.",
    parameters: Type.Object({
      key: Type.String({ description: "Secret key name (e.g. SLACK_BOT_TOKEN)." }),
      environment: Type.Optional(Type.String({
        description: "Override environment slug. Defaults to the IDENTITY.md binding.",
      })),
    }),
    async execute(_id, params): Promise<ToolExecuteResult> {
      try {
        const broker = await state.getBroker();
        const value = await broker.getSecret(params.key as string, {
          environment: params.environment as string | undefined,
        });
        // Never echo secret values in plain text — return a redacted marker
        // and rely on materialize_env / direct fetch for actual use.
        return textResult(
          `Secret '${params.key}' resolved (length ${value.length}). ` +
          `Use secr.materialize_env to inject into process.env without exposing in chat.`
        );
      } catch (err: any) {
        return textResult(`Failed to resolve secret '${params.key}': ${err?.message ?? err}`, true);
      }
    },
  });

  // ─── secr.list_envs ──────────────────────────────────────────────────────
  api.registerTool({
    name: "secr.list_envs",
    description:
      "List the secret keys this agent is allowed to read in the current environment. Returns key names only — never values.",
    parameters: Type.Object({}),
    async execute(): Promise<ToolExecuteResult> {
      try {
        const broker = await state.getBroker();
        const all = await broker.getAll();
        const keys = Object.keys(all).sort();
        if (keys.length === 0) {
          return textResult(
            "No secrets accessible. Either the allowlist is empty or no secrets exist in this environment."
          );
        }
        return textResult(
          `Allowed secrets (${keys.length}): ${keys.join(", ")}`
        );
      } catch (err: any) {
        return textResult(`Failed to list secrets: ${err?.message ?? err}`, true);
      }
    },
  });

  // ─── secr.materialize_env ────────────────────────────────────────────────
  api.registerTool({
    name: "secr.materialize_env",
    description:
      "Inject the agent's allowlisted secrets into process.env. Existing env values are preserved unless overwrite=true. Returns the list of keys that were written.",
    parameters: Type.Object({
      overwrite: Type.Optional(Type.Boolean({
        description: "If true, overwrite existing env vars with the same key. Defaults to false.",
      })),
    }),
    async execute(_id, params): Promise<ToolExecuteResult> {
      try {
        const broker = await state.getBroker();
        const written = await broker.materializeEnv({ overwrite: params.overwrite as boolean });
        if (written.length === 0) {
          return textResult(
            "No new env vars were written (existing values were preserved or no secrets accessible)."
          );
        }
        return textResult(
          `Injected ${written.length} secret(s) into process.env: ${written.join(", ")}`
        );
      } catch (err: any) {
        return textResult(`Failed to materialize env: ${err?.message ?? err}`, true);
      }
    },
  });
}
