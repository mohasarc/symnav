import { describe, expect, it } from "vitest";
import type {
  DefinitionResult,
  GraphResult,
  OverviewFileSymbols,
  RefsResult,
  ResolveResult,
  SymbolOverviewNode,
} from "@symnav/core";
import { defCommand } from "./def/def-command.js";
import { graphCommand } from "./graph/graph-command.js";
import { overviewCommand } from "./overview/overview-command.js";
import { refsCommand } from "./refs/refs-command.js";
import { resolveCommand } from "./resolve/resolve-command.js";

const symbol = (
  name: string,
  children: readonly SymbolOverviewNode[] = [],
): SymbolOverviewNode => ({
  type: "symbol",
  identity: { file: "src/a.ts", segments: [{ name }] },
  kind: { role: "callable", nativeLabel: "function" },
  range: { startLine: 1, endLine: 1 },
  header: { startLine: 1, lines: [`function ${name}(): void`] },
  children,
});

describe("command telemetry descriptors", () => {
  it("names each command", () => {
    expect(overviewCommand.name).toBe("overview");
    expect(resolveCommand.name).toBe("resolve");
    expect(defCommand.name).toBe("def");
    expect(refsCommand.name).toBe("refs");
    expect(graphCommand.name).toBe("graph");
  });

  it("describes overview arguments", () => {
    expect(overviewCommand.describeArgs({ file: "src/a.ts" })).toEqual({
      kind: "path",
      lengthBucket: "short",
      flags: [],
    });
  });

  it("describes resolve arguments", () => {
    expect(resolveCommand.describeArgs({ query: "Foo", fuzzy: true })).toEqual({
      kind: "bare",
      lengthBucket: "short",
      flags: ["fuzzy"],
    });
  });

  it("describes def arguments", () => {
    expect(defCommand.describeArgs({ symbolId: "a.ts::Foo" })).toEqual({
      kind: "symbol_id",
      lengthBucket: "short",
      flags: [],
    });
  });

  it("describes refs arguments", () => {
    expect(
      refsCommand.describeArgs({
        symbolId: "a.ts::Foo",
        page: 2,
        pageSize: undefined,
        all: true,
        fullLines: false,
      }),
    ).toEqual({
      kind: "symbol_id",
      lengthBucket: "short",
      flags: ["all", "page"],
    });
  });

  it("describes graph arguments", () => {
    expect(
      graphCommand.describeArgs({
        symbolId: "a.ts::Foo",
        incoming: true,
        outgoing: false,
        depth: 2,
        page: undefined,
        pageSize: 5,
        all: true,
      }),
    ).toEqual({
      kind: "symbol_id",
      lengthBucket: "short",
      flags: ["all", "depth", "incoming", "page-size"],
    });
  });

  it("counts overview result symbols recursively", () => {
    const result: OverviewFileSymbols = {
      file: "src/a.ts",
      entries: [symbol("top", [symbol("nested", [symbol("leaf")])]), symbol("other")],
    };

    expect(overviewCommand.countResults(result)).toEqual({ symbols: 4 });
  });

  it("counts resolve result symbols and files", () => {
    const result: ResolveResult = {
      query: "Foo",
      fuzzy: false,
      symbols: [symbol("one"), symbol("two")],
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    };

    expect(resolveCommand.countResults(result)).toEqual({ symbols: 2, files: 3 });
  });

  it("counts def result definitions", () => {
    const result: DefinitionResult = {
      identity: { file: "src/a.ts", segments: [{ name: "Foo" }] },
      symbols: [symbol("one"), symbol("two")],
    };

    expect(defCommand.countResults(result)).toEqual({ definitions: 2 });
  });

  it("counts refs result totals and visible page references", () => {
    const result: RefsResult = {
      identity: { file: "src/a.ts", segments: [{ name: "Foo" }] },
      total: 12,
      kindCounts: { usage: 12, import: 0, export: 0, type: 0 },
      page: 2,
      pageCount: 6,
      fullLines: false,
      references: [
        {
          file: "src/a.ts",
          line: 3,
          previewSource: "Foo();",
          matchStart: 0,
          matchEnd: 3,
          kind: "usage",
        },
        {
          file: "src/b.ts",
          line: 8,
          previewSource: "Foo();",
          matchStart: 0,
          matchEnd: 3,
          kind: "usage",
        },
      ],
    };

    expect(refsCommand.countResults(result)).toEqual({ total: 12, page: 2, pages: 6 });
  });

  it("counts graph result path totals and pages", () => {
    const result: GraphResult = {
      identity: { file: "src/a.ts", segments: [{ name: "Foo" }] },
      root: symbol("Foo"),
      depth: 2,
      direction: "both",
      incoming: { paths: [], totalPathCount: 3 },
      outgoing: { paths: [], totalPathCount: 4 },
      page: 1,
      pageCount: 2,
      repeatedSymbolCount: 0,
    };

    expect(graphCommand.countResults(result)).toEqual({
      incomingPaths: 3,
      outgoingPaths: 4,
      pages: 2,
    });
  });
});
