import { Node, SyntaxKind, type ClassDeclaration } from "ts-morph";
import { describe, expect, it } from "vitest";
import { CollectingDiagnosticSink } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractStatementDecls } from "./extract-children.js";
import { extractFileSymbols } from "./extract-file-symbols.js";

describe("extraction diagnostics", () => {
  it("reports an unrecognised statement kind once per file and kind", () => {
    const sourceFile = parseTypeScriptSource(
      ["const skipped = 1;", "export function render() {}"].join("\n"),
    );
    const unhandled = sourceFile.getFirstDescendantByKindOrThrow(SyntaxKind.Identifier);
    const render = sourceFile.getStatements()[1];
    if (!render) throw new Error("expected render declaration");
    const diagnostics = new CollectingDiagnosticSink();

    const symbols = extractStatementDecls([unhandled, unhandled, render], {
      file: "src/input.ts",
      ancestorNames: [],
      diagnostics,
    });

    expect(symbols.map((symbol) => symbol.identity.segments.at(-1)?.name)).toEqual(["render"]);
    expect(diagnostics.diagnostics()).toEqual([
      {
        severity: "warning",
        dedupeKey: "src/input.ts:statement:Identifier",
        message: "skipped unrecognised statement syntax at src/input.ts:1 (Identifier)",
      },
    ]);
  });

  it("does not report known namespace export syntax", () => {
    const sourceFile = parseTypeScriptSource(
      ["export as namespace katex;", "export function render() {}"].join("\n"),
    );
    const diagnostics = new CollectingDiagnosticSink();

    const result = extractFileSymbols({
      sourceFile,
      filePath: "src/input.ts",
      diagnostics,
    });

    expect(result.symbols.map((symbol) => symbol.identity.segments.at(-1)?.name)).toEqual([
      "render",
    ]);
    expect(diagnostics.diagnostics()).toEqual([]);
  });

  it("reports an unrecognised member kind once per file and kind", () => {
    const sourceFile = parseTypeScriptSource(
      ["class Box {", "  render() {}", "}", "const skipped = 1;"].join("\n"),
    );
    const box = sourceFile.getClassOrThrow("Box");
    const render = box.getMethods()[0];
    const unhandled = sourceFile.getVariableDeclarationOrThrow("skipped").getNameNode();
    if (!render) throw new Error("expected render method");
    replaceMembers(box, [unhandled, unhandled, render]);
    const diagnostics = new CollectingDiagnosticSink();

    const result = extractFileSymbols({
      sourceFile,
      filePath: "src/input.ts",
      diagnostics,
    });

    expect(
      result.symbols[0]?.children.map((symbol) => symbol.identity.segments.at(-1)?.name),
    ).toEqual(["render"]);
    expect(diagnostics.diagnostics()).toEqual([
      {
        severity: "warning",
        dedupeKey: "src/input.ts:member:Identifier",
        message: "skipped unrecognised member syntax at src/input.ts:4 (Identifier)",
      },
    ]);
  });
});

function replaceMembers(parent: ClassDeclaration, members: readonly Node[]): void {
  Object.defineProperty(parent, "getMembers", {
    value: () => members,
  });
}
