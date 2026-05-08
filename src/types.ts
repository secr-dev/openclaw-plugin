/**
 * Local types mirroring the OpenClaw plugin SDK contracts. We don't import
 * directly from `openclaw/plugin-sdk` so the package can build standalone in
 * the secr monorepo (the OpenClaw runtime injects the real SDK at install
 * time on the user's machine). Keep these in sync with the docs:
 *
 *   https://docs.openclaw.ai/plugins/hooks
 *   https://docs.openclaw.ai/plugins/building-plugins
 */

export interface PluginConfig {
  apiUrl?: string;
  identityPath?: string;
  tokenEnvVar?: string;
  /** Direct token override. Takes precedence over tokenEnvVar. */
  token?: string;
  /** Override IDENTITY.md frontmatter — useful when the file isn't present. */
  org?: string;
  project?: string;
  environment?: string;
  materializeOnStartup?: boolean;
  enforceGateway?: boolean;
}

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface PluginContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  jobId?: string;
  trace?: unknown;
  pluginConfig?: PluginConfig;
}

export interface RequireApprovalDecision {
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical";
  timeoutMs?: number;
  timeoutBehavior?: "allow" | "deny";
  pluginId?: string;
  onResolution?: (
    decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
  ) => Promise<void> | void;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: RequireApprovalDecision;
}

export interface ToolExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface RegisterToolDef {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolExecuteResult>;
}

/**
 * Tool-call hook handler signature. The OpenClaw runtime calls this through
 * api.on("before_tool_call", handler) — NOT registerHook (which is for the
 * InternalHookEvent type used by command/session/agent events).
 */
export type BeforeToolCallHandler = (
  event: BeforeToolCallEvent,
  ctx: PluginContext,
) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;

export interface OpenClawPluginApi {
  registerTool(def: RegisterToolDef, opts?: { optional?: boolean }): void;
  /**
   * Lifecycle hook registration for typed plugin hooks (before_tool_call,
   * after_tool_call, llm_input/output, etc). This is the API the runtime's
   * pi-tools.before_tool_call invocation path uses to discover handlers.
   */
  on(
    event: "before_tool_call",
    handler: BeforeToolCallHandler,
    opts?: { priority?: number; timeoutMs?: number },
  ): void;
  /** Legacy: command/session InternalHookEvent registration. Different event shape. */
  registerHook?(
    events: string | string[],
    handler: (event: { type: string; action: string; sessionKey: string; context: Record<string, unknown>; timestamp: Date; messages: string[] }) => Promise<void> | void,
    opts?: { name?: string },
  ): void;
  registerService?(def: { name: string; start: () => Promise<void> | void; stop?: () => Promise<void> | void }): void;
  registrationMode?: "full" | "discovery" | "setup-only" | "setup-runtime" | "cli-metadata";
}

export interface PluginEntryDef {
  id: string;
  name: string;
  description?: string;
  register: (api: OpenClawPluginApi) => void | Promise<void>;
}
