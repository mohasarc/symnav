import { describe, expect, it } from "vitest";

import type { SymbolDecl, SymbolKind } from "./types.js";
import { buildSymbolPath } from "./symbol-path.js";

function decl(name: string, kind: SymbolKind): SymbolDecl {
  return {
    kind,
    name,
    range: { startLine: 1, endLine: 1 },
    signatureSource: "",
    children: [],
  };
}

describe("buildSymbolPath", () => {
  it("returns the local name for a top-level decl with no ancestors", () => {
    const leaf = decl("greet", { role: "callable", nativeLabel: "function" });
    expect(buildSymbolPath([], leaf)).toBe("greet");
  });

  it("joins ancestor names with `::`", () => {
    const ancestor = decl("CheckoutService", { role: "container", nativeLabel: "class" });
    const leaf = decl("processPayment", { role: "callable", nativeLabel: "method" });
    expect(buildSymbolPath([ancestor], leaf)).toBe("CheckoutService::processPayment");
  });

  it("handles three-deep nesting (namespace -> class -> method)", () => {
    const outer = decl("Outer", { role: "container", nativeLabel: "namespace" });
    const inner = decl("Inner", { role: "container", nativeLabel: "class" });
    const leaf = decl("method", { role: "callable", nativeLabel: "method" });
    expect(buildSymbolPath([outer, inner], leaf)).toBe("Outer::Inner::method");
  });
});
