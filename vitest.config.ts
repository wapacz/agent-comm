import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
