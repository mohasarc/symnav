import { describe, expect, it } from "vitest";

import { BackendRouter } from "./backend-router.js";
import type { LanguageBackend } from "./language-backend.js";
import type { OverviewFileSymbols } from "../intermediate-representation/types.js";
import type { ResolvedPath } from "../workspace/workspace.js";

function fakeBackend(
  label: string,
  accepts: (path: string) => boolean,
): LanguageBackend & { label: string } {
  return {
    label,
    accepts,
    fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols> {
      return Promise.resolve({ file: path.relative, symbols: [] });
    },
  };
}

describe("BackendRouter", () => {
  it("returns the first backend whose accepts() is true", () => {
    const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
    const pyBackend = fakeBackend("py", (p) => p.endsWith(".py"));
    const router = new BackendRouter([tsBackend, pyBackend]);

    const found = router.find("foo.ts") as ReturnType<typeof fakeBackend> | undefined;
    expect(found?.label).toBe("ts");
  });

  it("returns undefined when no backend accepts the path", () => {
    const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
    const router = new BackendRouter([tsBackend]);

    expect(router.find("foo.json")).toBeUndefined();
  });

  it("preserves registration order on tie", () => {
    const first = fakeBackend("first", () => true);
    const second = fakeBackend("second", () => true);
    const router = new BackendRouter([first, second]);

    const found = router.find("anything.ts") as ReturnType<typeof fakeBackend> | undefined;
    expect(found?.label).toBe("first");
  });
});
