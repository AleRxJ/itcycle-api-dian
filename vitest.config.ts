import { defineConfig } from "vitest/config";

// ITCycle's own test suite only. dian-kit's tests run separately inside
// dian-engine/ (`pnpm test` there) — see docs/dian/compatibility.md.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    hookTimeout: 30000,
  },
});
