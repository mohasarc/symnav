import { describe, expect, it } from "vitest";
import type { FileSymbols } from "./ir.js";
import { BackendRouter, type LanguageBackend } from "./backend.js";

function fake(extensions: readonly string[]): LanguageBackend {
  return {
    accepts(filePath) {
      return extensions.some((ext) => filePath.endsWith(ext));
    },
    fileSymbols(filePath) {
      return Promise.resolve<FileSymbols>({
        filePath,
        symbols: [],
      });
    },
  };
}

describe("BackendRouter", () => {
  it("returns the first backend that accepts the path", () => {
    const ts = fake([".ts"]);
    const py = fake([".py"]);
    const router = new BackendRouter([ts, py]);
    expect(router.find("foo.ts")).toBe(ts);
    expect(router.find("foo.py")).toBe(py);
  });

  it("returns undefined when no backend accepts the path", () => {
    const router = new BackendRouter([fake([".ts"])]);
    expect(router.find("foo.json")).toBeUndefined();
  });

  it("preserves registration order on tie", () => {
    const first = fake([".ts"]);
    const second = fake([".ts"]);
    const router = new BackendRouter([first, second]);
    expect(router.find("foo.ts")).toBe(first);
  });
});
