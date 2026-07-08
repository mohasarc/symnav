import { describe, expect, it } from "vitest";

import { BackendRouter } from "./backend-router.js";
import { UnsupportedFileError } from "./errors.js";
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
      return Promise.resolve({ file: path.relative, entries: [] });
    },
    resolveSymbols() {
      return Promise.resolve([]);
    },
    findDefinitions() {
      return Promise.resolve([]);
    },
    findReferences() {
      return Promise.resolve([]);
    },
    findCallTarget() {
      return Promise.resolve({ outcome: "not-found" });
    },
    findCallees() {
      return Promise.resolve([]);
    },
    findCallers() {
      return Promise.resolve([]);
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

  describe("findOrThrow", () => {
    it("returns the accepting backend (same as find)", () => {
      const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
      const router = new BackendRouter([tsBackend]);

      const found = router.findOrThrow("foo.ts") as ReturnType<typeof fakeBackend>;
      expect(found.label).toBe("ts");
    });

    it("throws UnsupportedFileError when no backend accepts", () => {
      const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
      const router = new BackendRouter([tsBackend]);

      try {
        router.findOrThrow("foo.json");
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedFileError);
        expect((err as UnsupportedFileError).reason).toContain("foo.json");
      }
    });
  });
});
