import { describe, expect, it } from "vitest";

import type { SymbolDecl } from "./types.js";
import { buildSymbolPath } from "./symbol-path.js";

function decl(name: string, kind: SymbolDecl["kind"]): SymbolDecl {
  return {
    kind,
    name,
    range: { startLine: 1, endLine: 1 },
    signature: "",
    children: [],
  };
}

describe("buildSymbolPath", () => {
  it("returns the local name for a top-level decl with no ancestors", () => {
    const leaf = decl("greet", "function");
    expect(buildSymbolPath([], leaf)).toBe("greet");
  });

  it("joins ancestor names with `::`", () => {
    const ancestor = decl("CheckoutService", "class");
    const leaf = decl("processPayment", "method");
    expect(buildSymbolPath([ancestor], leaf)).toBe("CheckoutService::processPayment");
  });

  it("handles three-deep nesting (namespace -> class -> method)", () => {
    const outer = decl("Outer", "namespace");
    const inner = decl("Inner", "class");
    const leaf = decl("method", "method");
    expect(buildSymbolPath([outer, inner], leaf)).toBe("Outer::Inner::method");
  });
});
