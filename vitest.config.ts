import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // The real `openclaw` package is provided by the runtime at install time
      // on a user's machine; in unit tests we shim it.
      "openclaw/plugin-sdk/plugin-entry": fileURLToPath(
        new URL("./src/__tests__/openclaw-mock.ts", import.meta.url),
      ),
    },
  },
});
