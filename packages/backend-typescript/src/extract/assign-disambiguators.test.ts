import { describe, expect, it } from "vitest";

import type { LineRange, Signature, SymbolIdentity, SymbolKind } from "@symnav/core";

import { assignDisambiguators } from "./assign-disambiguators.js";

interface IdentitySymbolDecl {
  readonly identity: SymbolIdentity;
  readonly kind: SymbolKind;
  readonly range: LineRange;
  readonly signature: Signature;
  readonly children: readonly IdentitySymbolDecl[];
}

const CALLABLE_METHOD: SymbolKind = { role: "callable", nativeLabel: "method" };
const CALLABLE_GETTER: SymbolKind = { role: "callable", nativeLabel: "getter" };
const CALLABLE_SETTER: SymbolKind = { role: "callable", nativeLabel: "setter" };
const CONTAINER_CLASS: SymbolKind = { role: "container", nativeLabel: "class" };

function leaf(name: string, kind: SymbolKind = CALLABLE_METHOD): IdentitySymbolDecl {
  return {
    identity: { file: "src/foo.ts", segments: [{ name }] },
    kind,
    range: { startLine: 1, endLine: 1 },
    signature: { startLine: 1, lines: [name] },
    children: [],
  };
}

function withChildren(
  name: string,
  children: readonly IdentitySymbolDecl[],
  kind: SymbolKind = CONTAINER_CLASS,
): IdentitySymbolDecl {
  return {
    identity: { file: "src/foo.ts", segments: [{ name }] },
    kind,
    range: { startLine: 1, endLine: 10 },
    signature: { startLine: 1, lines: [name] },
    children,
  };
}

function disambiguatorOf(decl: IdentitySymbolDecl): number | undefined {
  return decl.identity.segments[decl.identity.segments.length - 1]?.disambiguator;
}

describe("assignDisambiguators", () => {
  it("leaves disambiguator undefined when each sibling name is unique", () => {
    const result = assignDisambiguators([leaf("foo"), leaf("bar"), leaf("baz")]);
    for (const decl of result) {
      expect(disambiguatorOf(decl)).toBeUndefined();
    }
  });

  it("assigns sequential #1, #2, #3 to a three-element overload set in source order", () => {
    const result = assignDisambiguators([leaf("post"), leaf("post"), leaf("post")]);
    expect(result.map(disambiguatorOf)).toEqual([1, 2, 3]);
  });

  it("assigns #1 to the first occurrence and #2 to the second in a static/instance collision", () => {
    const result = assignDisambiguators([leaf("bar"), leaf("bar")]);
    expect(result.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("assigns #1/#2 to a getter/setter pair colliding on name in source order", () => {
    const result = assignDisambiguators([
      leaf("bar", CALLABLE_GETTER),
      leaf("bar", CALLABLE_SETTER),
    ]);
    expect(result.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("recurses into children so nested collisions get disambiguated", () => {
    const inner = [leaf("m"), leaf("m")];
    const outer = withChildren("Inner", inner);
    const result = assignDisambiguators([outer]);
    const resolved = result[0];
    expect(resolved).toBeDefined();
    expect(resolved!.children.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("only disambiguates within the same sibling scope (independent groups don't share counts)", () => {
    const a = withChildren("A", [leaf("m"), leaf("m")]);
    const b = withChildren("B", [leaf("m"), leaf("m")]);
    const result = assignDisambiguators([a, b]);
    expect(result[0]!.children.map(disambiguatorOf)).toEqual([1, 2]);
    expect(result[1]!.children.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("returns an empty array when given no siblings", () => {
    expect(assignDisambiguators([])).toEqual([]);
  });
});
