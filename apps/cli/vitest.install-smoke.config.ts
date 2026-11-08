import { defineConfig } from "vitest/config";

const INSTALL_SMOKE_TIMEOUT_MS = 180_000;

export default defineConfig({
  test: {
    include: ["test/install-smoke/**/*.test.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    testTimeout: INSTALL_SMOKE_TIMEOUT_MS,
    hookTimeout: INSTALL_SMOKE_TIMEOUT_MS,
  },
});
