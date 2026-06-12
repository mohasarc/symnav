import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import type { ReferenceKind } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { classifyReferenceKind } from "./classify-reference-kind.js";

function kindsOf(source: string, name: string): readonly ReferenceKind[] {
  const sourceFile = parseTypeScriptSource(source);
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((identifier) => identifier.getText() === name)
    .map((identifier) => classifyReferenceKind(identifier));
}

describe("classifyReferenceKind", () => {
  it("classifies a named import as import", () => {
    expect(kindsOf('import { X } from "./x.js";', "X")).toEqual(["import"]);
  });

  it("classifies a default import as import", () => {
    expect(kindsOf('import X from "./x.js";', "X")).toEqual(["import"]);
  });

  it("classifies a type-only import as import", () => {
    expect(kindsOf('import type { X } from "./x.js";', "X")).toEqual(["import"]);
  });

  it("classifies an export clause as export", () => {
    expect(kindsOf("export { X };", "X")).toEqual(["export"]);
  });

  it("classifies a re-export as export", () => {
    expect(kindsOf('export { X } from "./x.js";', "X")).toEqual(["export"]);
  });

  it("classifies an export assignment as export", () => {
    expect(kindsOf("export default X;", "X")).toEqual(["export"]);
  });

  it("classifies a type annotation as type", () => {
    expect(kindsOf("let a: X;", "X")).toEqual(["type"]);
  });

  it("classifies a generic type argument as type", () => {
    expect(kindsOf("let list: Array<X>;", "X")).toEqual(["type"]);
  });

  it("classifies an implements clause as type", () => {
    expect(kindsOf("class C implements X {}", "X")).toEqual(["type"]);
  });

  it("classifies typeof in type position as type", () => {
    expect(kindsOf("let t: typeof X;", "X")).toEqual(["type"]);
  });

  it("classifies a call as usage", () => {
    expect(kindsOf("X();", "X")).toEqual(["usage"]);
  });

  it("classifies a new expression as usage", () => {
    expect(kindsOf("new X();", "X")).toEqual(["usage"]);
  });

  it("classifies a property access as usage", () => {
    expect(kindsOf("X.prop;", "X")).toEqual(["usage"]);
  });

  it("classifies extends of a concrete class as usage", () => {
    expect(kindsOf("class C extends X {}", "X")).toEqual(["usage"]);
  });

  it("classifies an identifier read as usage", () => {
    expect(kindsOf("const y = X;", "X")).toEqual(["usage"]);
  });
});
