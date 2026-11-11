import { defineConfig } from "vitest/config";

/**
 * Unit/integration tests run in plain Node (Worker code only uses Web-standard APIs,
 * and R2/Groq are replaced by in-memory fakes). Frontend tests use jsdom via a
 * per-file `@vitest-environment jsdom` pragma.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/helpers/setup.ts"],
  },
  esbuild: { jsx: "automatic" },
});
