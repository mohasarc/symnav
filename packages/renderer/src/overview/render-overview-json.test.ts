import { describe, expect, it } from "vitest";

import type {
  FoldOverviewNode,
  OverviewFileEntries,
  OverviewNode,
  SymbolKind,
  SymbolOverviewNode,
} from "@symnav/core";

import { renderOverviewJson } from "./render-overview-json.js";

interface DeclPartial {
  readonly segments: readonly { readonly name: string; readonly disambiguator?: number }[];
  readonly kind: SymbolKind;
  readonly range?: SymbolOverviewNode["range"];
  readonly header?: SymbolOverviewNode["header"];
  readonly children?: readonly OverviewNode[];
}

function decl(partial: DeclPartial, file: string = "src/file.ts"): SymbolOverviewNode {
  return {
    type: "symbol",
    identity: { file, segments: partial.segments },
    kind: partial.kind,
    range: partial.range ?? { startLine: 1, endLine: 1 },
    header: partial.header ?? { startLine: 1, lines: [""] },
    children: partial.children ?? [],
  };
}

function fold(children: readonly OverviewNode[] = []): FoldOverviewNode {
  return {
    type: "fold",
    foldKind: "block",
    range: { startLine: 2, endLine: 4 },
    header: { startLine: 2, lines: ["{"] },
    children,
  };
}

describe("renderOverviewJson", () => {
  it("mirrors overview entries verbatim with `children` always present on leaf decls", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: { role: "callable", nativeLabel: "function" },
          segments: [{ name: "leaf" }],
          range: { startLine: 4, endLine: 4 },
          header: { startLine: 4, lines: ["function leaf(): void"] },
        }),
      ],
    };
    const parsed = JSON.parse(renderOverviewJson(file));
    expect(parsed).toEqual({
      file: "src/file.ts",
      entries: [
        {
          type: "symbol",
          identity: { file: "src/file.ts", segments: [{ name: "leaf" }] },
          kind: { role: "callable", nativeLabel: "function" },
          range: { startLine: 4, endLine: 4 },
          header: { startLine: 4, lines: ["function leaf(): void"] },
          children: [],
        },
      ],
    });
  });

  it("emits a discriminant for symbol and fold entries", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [decl({ kind: { role: "callable", nativeLabel: "function" }, segments: [{ name: "leaf" }] }), fold()],
    };

    const parsed = JSON.parse(renderOverviewJson(file)) as OverviewFileEntries;

    expect(parsed.entries.map((entry) => entry.type)).toEqual(["symbol", "fold"]);
  });

  it("emits 2-space-indented output with a trailing newline", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: { role: "callable", nativeLabel: "function" },
          segments: [{ name: "leaf" }],
          header: { startLine: 1, lines: ["function leaf(): void"] },
        }),
      ],
    };
    const output = renderOverviewJson(file);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);

    const lines = output.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[1]).toBe(`  "entries": [`);
  });

  it("emits the header object with its startLine and lines", () => {
    const file: OverviewFileEntries = {
      file: "src/file.ts",
      entries: [
        decl({
          kind: { role: "callable", nativeLabel: "function" },
          segments: [{ name: "configure" }],
          range: { startLine: 10, endLine: 12 },
          header: {
            startLine: 10,
            lines: ["function configure(", "  host: string,", "): void"],
          },
        }),
      ],
    };
    const parsed = JSON.parse(renderOverviewJson(file)) as OverviewFileEntries;
    expect(parsed.entries[0]?.header).toEqual({
      startLine: 10,
      lines: ["function configure(", "  host: string,", "): void"],
    });
  });

  it("includes diagnostics in the payload when the result carries them", () => {
    const file: OverviewFileSymbols = {
      file: "src/file.ts",
      symbols: [],
      diagnostics: [
        {
          severity: "warning",
          dedupeKey: "src/file.ts:statement:Identifier",
          message: "skipped unrecognised statement syntax at src/file.ts:1 (Identifier)",
        },
      ],
    };
    const parsed = JSON.parse(renderOverviewJson(file)) as OverviewFileSymbols;
    expect(parsed.diagnostics).toEqual([
      {
        severity: "warning",
        dedupeKey: "src/file.ts:statement:Identifier",
        message: "skipped unrecognised statement syntax at src/file.ts:1 (Identifier)",
      },
    ]);
  });

  it("renders identical bytes for identical IR across two calls", () => {
    const build = (): OverviewFileEntries => ({
      file: "src/file.ts",
      entries: [
        decl({
          kind: { role: "container", nativeLabel: "class" },
          segments: [{ name: "C" }],
          range: { startLine: 1, endLine: 10 },
          header: { startLine: 1, lines: ["class C"] },
          children: [
            decl({
              kind: { role: "callable", nativeLabel: "method" },
              segments: [{ name: "C" }, { name: "m" }],
              range: { startLine: 2, endLine: 4 },
              header: { startLine: 2, lines: ["m(): void"] },
            }),
          ],
        }),
      ],
    });
    expect(renderOverviewJson(build())).toBe(renderOverviewJson(build()));
  });
});
