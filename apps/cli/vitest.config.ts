import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/install-smoke/**"],
    fileParallelism: false,
    passWithNoTests: false,
  },
});
