import { describe, expect, it } from "vitest";
import {
  buildSymbolPath,
  type FileSymbols,
  type LineRange,
  type SymbolDecl,
  type SymbolKind,
} from "./index.js";

describe("@symnav/core public surface", () => {
  it("exports IR types and buildSymbolPath", () => {
    const range: LineRange = { startLine: 1, endLine: 1 };
    const kind: SymbolKind = "function";
    const decl: SymbolDecl = {
      kind,
      name: "f",
      range,
      signature: "f()",
      children: [],
    };
    const file: FileSymbols = { filePath: "x.ts", symbols: [decl] };

    expect(typeof buildSymbolPath).toBe("function");
    expect(buildSymbolPath([], file.symbols[0]!)).toBe("f");
  });
});
