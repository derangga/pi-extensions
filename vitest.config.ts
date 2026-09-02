import { defineConfig } from "vitest/config";

// Scoped to `packages/` on purpose. The vendored reference clones at the repo
// root (pi-extensions, pi-footer, rpiv-mono) carry thousands of their own test
// files; a default glob would run all of them.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
