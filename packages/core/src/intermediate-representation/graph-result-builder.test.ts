import { describe, expect, it } from "vitest";

import type { GraphPath } from "../graph/graph-path.js";
import { InvalidPageRequestError, PageOutOfRangeError } from "../pagination/errors.js";
import { GraphResultBuilder, type BuildGraphResultArgs } from "./graph-result-builder.js";
import type { GraphDirection } from "./graph-result.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolOverviewNode } from "./overview-tree.js";

function symbol(name: string, file = `src/${name}.ts`): SymbolOverviewNode {
  return {
    type: "symbol",
    identity: { file, segments: [{ name }] },
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    header: { startLine: 1, lines: [`function ${name}()`] },
    children: [],
  };
}

function path(...symbols: readonly SymbolOverviewNode[]): GraphPath {
  return {
    steps: symbols.map((each) => ({
      symbol: each,
      confidence: "certain",
      closesCycle: false,
    })),
  };
}

function names(paths: readonly GraphPath[]): readonly string[] {
  return paths.map((each) =>
    each.steps.map((step) => step.symbol.identity.segments[0]!.name).join(" -> "),
  );
}

function build(overrides: Partial<BuildGraphResultArgs> = {}) {
  const root = symbol("root");
  const args: BuildGraphResultArgs = {
    identity: root.identity,
    root,
    depth: 2,
    direction: "both",
    incomingPaths: [],
    outgoingPaths: [],
    pageRequest: { all: false },
    ...overrides,
  };
  return new GraphResultBuilder(args).build();
}

function numberedPaths(prefix: string, count: number): readonly GraphPath[] {
  return Array.from({ length: count }, (_, index) => path(symbol(`${prefix}${index + 1}`)));
}

describe("GraphResultBuilder", () => {
  it("splits an even page budget between both directions", () => {
    const result = build({
      incomingPaths: numberedPaths("in", 3),
      outgoingPaths: numberedPaths("out", 3),
      pageRequest: { pageSize: 4, all: false },
    });

    expect(names(result.incoming!.paths)).toEqual(["in1", "in2"]);
    expect(names(result.outgoing!.paths)).toEqual(["out1", "out2"]);
    expect(result.incoming!.totalPathCount).toBe(3);
    expect(result.outgoing!.totalPathCount).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(2);
  });

  it("gives incoming the larger half for odd both-direction budgets", () => {
    const result = build({
      incomingPaths: numberedPaths("in", 4),
      outgoingPaths: numberedPaths("out", 4),
      pageRequest: { pageSize: 5, all: false },
    });

    expect(names(result.incoming!.paths)).toEqual(["in1", "in2", "in3"]);
    expect(names(result.outgoing!.paths)).toEqual(["out1", "out2"]);
  });

  it("uses the full page budget for a single direction", () => {
    const result = build({
      direction: "incoming",
      incomingPaths: numberedPaths("in", 5),
      outgoingPaths: numberedPaths("out", 5),
      pageRequest: { pageSize: 4, all: false },
    });

    expect(names(result.incoming!.paths)).toEqual(["in1", "in2", "in3", "in4"]);
    expect(result.incoming!.totalPathCount).toBe(5);
    expect(result.outgoing).toBeUndefined();
    expect(result.pageCount).toBe(2);
  });

  it("uses the max page count across uneven directions", () => {
    const result = build({
      incomingPaths: numberedPaths("in", 10),
      outgoingPaths: numberedPaths("out", 1),
      pageRequest: { page: 3, pageSize: 4, all: false },
    });

    expect(names(result.incoming!.paths)).toEqual(["in5", "in6"]);
    expect(result.outgoing!.paths).toEqual([]);
    expect(result.page).toBe(3);
    expect(result.pageCount).toBe(5);
  });

  it("returns all paths as a single page", () => {
    const result = build({
      incomingPaths: numberedPaths("in", 3),
      outgoingPaths: numberedPaths("out", 2),
      pageRequest: { all: true },
    });

    expect(names(result.incoming!.paths)).toEqual(["in1", "in2", "in3"]);
    expect(names(result.outgoing!.paths)).toEqual(["out1", "out2"]);
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(1);
  });

  it("rejects a page beyond the graph page count", () => {
    expect(() =>
      build({
        incomingPaths: numberedPaths("in", 3),
        outgoingPaths: numberedPaths("out", 3),
        pageRequest: { page: 3, pageSize: 4, all: false },
      }),
    ).toThrowError(PageOutOfRangeError);
  });

  it("rejects a both-direction page size that cannot give each direction a budget", () => {
    expect(() =>
      build({
        incomingPaths: [],
        outgoingPaths: numberedPaths("out", 2),
        pageRequest: { pageSize: 1, all: false },
      }),
    ).toThrowError(InvalidPageRequestError);
  });

  it("treats no paths as one empty page", () => {
    const result = build();

    expect(result.incoming!.paths).toEqual([]);
    expect(result.outgoing!.paths).toEqual([]);
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(1);
  });

  it("counts repeated non-root symbols on the displayed page", () => {
    const shared = symbol("shared");
    const root = symbol("root");
    const result = build({
      identity: root.identity,
      root,
      direction: "incoming",
      incomingPaths: [path(symbol("left"), shared, root), path(symbol("right"), shared, root)],
      pageRequest: { pageSize: 2, all: false },
    });

    expect(result.repeatedSymbolCount).toBe(1);
  });

  it("does not count symbols repeated only across undisplayed pages", () => {
    const repeated = symbol("repeated");
    const result = build({
      direction: "incoming",
      incomingPaths: [path(symbol("first"), repeated), path(symbol("second"), repeated)],
      pageRequest: { pageSize: 1, all: false },
    });

    expect(result.repeatedSymbolCount).toBe(0);
  });

  it("does not count the root as repeated", () => {
    const root = symbol("root");
    const result = build({
      identity: root.identity,
      root,
      incomingPaths: [path(root), path(root)],
      pageRequest: { pageSize: 2, all: false },
    });

    expect(result.repeatedSymbolCount).toBe(0);
  });

  it.each<GraphDirection>(["incoming", "outgoing", "both"])(
    "preserves result metadata for %s",
    (direction) => {
      const root = symbol("root");
      const identity: SymbolIdentity = root.identity;
      const result = build({ identity, root, direction, depth: 4 });

      expect(result.identity).toBe(identity);
      expect(result.root).toBe(root);
      expect(result.depth).toBe(4);
      expect(result.direction).toBe(direction);
    },
  );
});
