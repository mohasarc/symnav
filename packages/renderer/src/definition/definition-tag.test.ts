import { describe, expect, it } from "vitest";

import type { DefinitionPairRole, DefinitionSymbol } from "@symnav/core";

import { bracketTagFor } from "./definition-tag.js";

describe("bracketTagFor", () => {
  it("maps method-implementation to implementation", () => {
    expect(bracketTagFor(labelled("method-implementation"))).toBe("implementation");
  });

  it("maps function-implementation to implementation", () => {
    expect(bracketTagFor(labelled("function-implementation"))).toBe("implementation");
  });

  it("maps constructor-implementation to implementation", () => {
    expect(bracketTagFor(labelled("constructor-implementation"))).toBe("implementation");
  });

  it("maps method-declaration to declaration", () => {
    expect(bracketTagFor(labelled("method-declaration"))).toBe("declaration");
  });

  it("maps method-overload-signature to overload", () => {
    expect(bracketTagFor(labelled("method-overload-signature"))).toBe("overload");
  });

  it("maps function-overload-signature to overload", () => {
    expect(bracketTagFor(labelled("function-overload-signature"))).toBe("overload");
  });

  it("maps constructor-overload-signature to overload", () => {
    expect(bracketTagFor(labelled("constructor-overload-signature"))).toBe("overload");
  });

  it("prefers the pair role over the label tag", () => {
    expect(bracketTagFor(paired("function-overload-signature", "declaration"))).toBe("declaration");
    expect(bracketTagFor(paired("variable", "implementation"))).toBe("implementation");
    expect(bracketTagFor(paired("class", "declaration"))).toBe("declaration");
  });

  it("returns undefined for unrelated labels", () => {
    expect(bracketTagFor(labelled("class"))).toBeUndefined();
    expect(bracketTagFor(labelled("variable"))).toBeUndefined();
    expect(bracketTagFor(labelled("interface"))).toBeUndefined();
  });
});

function labelled(nativeLabel: string): Pick<DefinitionSymbol, "kind"> {
  return { kind: { role: "callable", nativeLabel } };
}

function paired(
  nativeLabel: string,
  pairRole: DefinitionPairRole,
): Pick<DefinitionSymbol, "kind" | "pairRole"> {
  return { kind: { role: "value", nativeLabel }, pairRole };
}
