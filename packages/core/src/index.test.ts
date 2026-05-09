import { describe, expect, it } from "vitest";

import {
  buildSymbolPath,
  type FileSymbols,
  type LineRange,
  type SymbolDecl,
  type SymbolKind,
} from "./index.js";

describe("@symnav/core entry", () => {
  it("re-exports IR types and buildSymbolPath", () => {
    const range: LineRange = { startLine: 1, endLine: 1 };
    const kind: SymbolKind = "function";
    const decl: SymbolDecl = {
      kind,
      name: "greet",
      range,
      signature: "function greet(): void",
      children: [],
    };
    const file: FileSymbols = {
      filePath: "src/x.ts",
      symbols: [decl],
    };

    expect(file.symbols).toHaveLength(1);
    expect(typeof buildSymbolPath).toBe("function");
    expect(buildSymbolPath([], decl)).toBe("greet");
  });
});
