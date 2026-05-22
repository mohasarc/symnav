import { describe, expect, it } from "vitest";

import { assignDisambiguators } from "./assign-disambiguators.js";
import { formatSymbolIdentity } from "./canonical-identity.js";
import type { SymbolDecl, SymbolKind } from "./types.js";

const CALLABLE_METHOD: SymbolKind = { role: "callable", nativeLabel: "method" };
const CALLABLE_GETTER: SymbolKind = { role: "callable", nativeLabel: "getter" };
const CALLABLE_SETTER: SymbolKind = { role: "callable", nativeLabel: "setter" };
const CONTAINER_CLASS: SymbolKind = { role: "container", nativeLabel: "class" };

interface DeclSpec {
  readonly name: string;
  readonly kind?: SymbolKind;
  readonly children?: readonly DeclSpec[];
}

function buildSiblings(
  specs: readonly DeclSpec[],
  ancestors: readonly string[] = [],
): SymbolDecl[] {
  return specs.map((spec) => {
    const lineage = [...ancestors, spec.name];
    return {
      identity: { file: "src/foo.ts", segments: lineage.map((name) => ({ name })) },
      kind: spec.kind ?? CALLABLE_METHOD,
      range: { startLine: 1, endLine: 1 },
      signature: { startLine: 1, lines: [spec.name] },
      children: buildSiblings(spec.children ?? [], lineage),
    };
  });
}

function disambiguatorOf(decl: SymbolDecl): number | undefined {
  return decl.identity.segments[decl.identity.segments.length - 1]?.disambiguator;
}

describe("assignDisambiguators", () => {
  it("leaves disambiguator undefined when each sibling name is unique", () => {
    const result = assignDisambiguators(
      buildSiblings([{ name: "foo" }, { name: "bar" }, { name: "baz" }]),
    );
    for (const decl of result) {
      expect(disambiguatorOf(decl)).toBeUndefined();
    }
  });

  it("assigns sequential #1, #2, #3 to a three-element overload set in source order", () => {
    const result = assignDisambiguators(
      buildSiblings([{ name: "post" }, { name: "post" }, { name: "post" }]),
    );
    expect(result.map(disambiguatorOf)).toEqual([1, 2, 3]);
  });

  it("assigns #1/#2 to a colliding name regardless of kind, since collision is by name alone", () => {
    const result = assignDisambiguators(
      buildSiblings([
        { name: "bar", kind: CALLABLE_GETTER },
        { name: "bar", kind: CALLABLE_SETTER },
      ]),
    );
    expect(result.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("keeps independent groups at the same level on separate counts", () => {
    const result = assignDisambiguators(
      buildSiblings([{ name: "bar" }, { name: "bar" }, { name: "biz" }, { name: "biz" }]),
    );
    expect(result.map(disambiguatorOf)).toEqual([1, 2, 1, 2]);
  });

  it("recurses into children so nested collisions get disambiguated", () => {
    const result = assignDisambiguators(
      buildSiblings([
        { name: "Inner", kind: CONTAINER_CLASS, children: [{ name: "m" }, { name: "m" }] },
      ]),
    );
    expect(result[0]!.children.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("only disambiguates within the same sibling scope (independent groups don't share counts)", () => {
    const result = assignDisambiguators(
      buildSiblings([
        { name: "A", kind: CONTAINER_CLASS, children: [{ name: "m" }, { name: "m" }] },
        { name: "B", kind: CONTAINER_CLASS, children: [{ name: "m" }, { name: "m" }] },
      ]),
    );
    expect(result[0]!.children.map(disambiguatorOf)).toEqual([1, 2]);
    expect(result[1]!.children.map(disambiguatorOf)).toEqual([1, 2]);
  });

  it("propagates a parent's disambiguator into its descendants' path prefix", () => {
    const result = assignDisambiguators(
      buildSiblings([
        { name: "A", kind: CONTAINER_CLASS, children: [{ name: "m" }] },
        { name: "A", kind: CONTAINER_CLASS, children: [{ name: "m" }] },
      ]),
    );
    const firstChild = result[0]!.children[0]!;
    const secondChild = result[1]!.children[0]!;
    expect(formatSymbolIdentity(firstChild.identity)).toBe("src/foo.ts::A#1::m");
    expect(formatSymbolIdentity(secondChild.identity)).toBe("src/foo.ts::A#2::m");
  });

  it("disambiguates outer and inner simultaneously, yielding unique ids throughout", () => {
    const result = assignDisambiguators(
      buildSiblings([
        { name: "A", kind: CONTAINER_CLASS, children: [{ name: "B" }, { name: "B" }] },
        { name: "A", kind: CONTAINER_CLASS, children: [{ name: "B" }, { name: "B" }] },
      ]),
    );
    const innerIds = result.flatMap((outer) =>
      outer.children.map((inner) => formatSymbolIdentity(inner.identity)),
    );
    expect(innerIds).toEqual([
      "src/foo.ts::A#1::B#1",
      "src/foo.ts::A#1::B#2",
      "src/foo.ts::A#2::B#1",
      "src/foo.ts::A#2::B#2",
    ]);
    expect(new Set(innerIds).size).toBe(innerIds.length);
  });

  it("returns an empty array when given no siblings", () => {
    expect(assignDisambiguators([])).toEqual([]);
  });
});
