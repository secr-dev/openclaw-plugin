/**
 * Ambient declaration for the OpenClaw plugin SDK entrypoint we depend on.
 *
 * The `openclaw` package is a peerDependency provided by the runtime at
 * install time on the user's machine — but it isn't installed inside the secr
 * monorepo, so the TypeScript build needs an ambient module declaration to
 * accept the import. The runtime resolves the real symbol when OpenClaw
 * imports our compiled plugin.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginConfigSchemaShape = {
    type?: string;
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };

  export type DefinePluginEntryOptions<TApi> = {
    id: string;
    name: string;
    description: string;
    configSchema?: OpenClawPluginConfigSchemaShape | (() => OpenClawPluginConfigSchemaShape);
    register: (api: TApi) => void | Promise<void>;
  };

  export function definePluginEntry<TApi = unknown>(
    options: DefinePluginEntryOptions<TApi>,
  ): DefinePluginEntryOptions<TApi> & { __openclawPlugin: true };
}
