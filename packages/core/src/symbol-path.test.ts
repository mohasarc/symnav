import { describe, expect, it } from "vitest";
import type { SymbolDecl } from "./ir.js";
import { buildSymbolPath } from "./symbol-path.js";

function decl(name: string, kind: SymbolDecl["kind"] = "function"): SymbolDecl {
  return {
    kind,
    name,
    range: { startLine: 1, endLine: 1 },
    signature: "",
    children: [],
  };
}

describe("buildSymbolPath", () => {
  it("returns the local name for a top-level decl", () => {
    expect(buildSymbolPath([], decl("greet"))).toBe("greet");
  });

  it("joins ancestor names with ::", () => {
    const ancestors = [decl("CheckoutService", "class")];
    const leaf = decl("processPayment", "method");
    expect(buildSymbolPath(ancestors, leaf)).toBe(
      "CheckoutService::processPayment",
    );
  });

  it("handles three-deep nesting", () => {
    const ancestors = [decl("Outer", "namespace"), decl("Inner", "class")];
    const leaf = decl("method", "method");
    expect(buildSymbolPath(ancestors, leaf)).toBe("Outer::Inner::method");
  });
});
