import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["./test/e2e/global-setup.ts"],
    passWithNoTests: false,
  },
});
