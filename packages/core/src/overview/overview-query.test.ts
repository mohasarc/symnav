import { describe, expect, it } from "vitest";

import type { OverviewNode } from "../intermediate-representation/overview-tree.js";
import type { OverviewExpansionCandidate } from "./overview-expansion-result.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewTargetError,
  OverviewTargetNotFoundError,
} from "./overview-query.js";

const node: OverviewNode = {
  type: "fold",
  foldKind: "call",
  range: { startLine: 1, endLine: 3 },
  header: { startLine: 1, lines: ['describe("x", () => {'] },
  children: [],
};

function candidate(header: string, startLine: number, endLine: number): OverviewExpansionCandidate {
  return {
    header,
    range: { startLine, endLine },
    node,
  };
}

describe("overview target errors", () => {
  it("renders ambiguous target candidates with copied headers", () => {
    const err = new AmbiguousOverviewTargetError([
      candidate('1-3: describe("setup", () => {', 1, 3),
      candidate('5-9: describe("cursor", () => {', 5, 9),
    ]);

    expect(err.render()).toBe(
      [
        "Cannot answer: overview target matches multiple nodes.",
        "",
        "Candidates",
        '├── 1-3: describe("setup", () => {',
        '└── 5-9: describe("cursor", () => {',
        "",
      ].join("\n"),
    );
  });

  it("renders line ambiguity with candidate headers and guidance", () => {
    const err = new AmbiguousLineTargetError(1, [
      candidate('1: describe("alpha", () => {', 1, 1),
      candidate('1: describe("beta", () => {', 1, 1),
    ]);

    expect(err.render()).toBe(
      [
        "Cannot answer: line 1 matches multiple overview nodes; use --at with copied header text.",
        "",
        "Candidates",
        '├── 1: describe("alpha", () => {',
        '└── 1: describe("beta", () => {',
        "",
      ].join("\n"),
    );
  });

  it("renders not-found requests through the default user-facing format", () => {
    const err = new OverviewTargetNotFoundError({
      depth: 0,
      at: "describe",
      line: 9,
    });

    expect(err.render()).toBe(
      'Cannot answer: no overview target matching --at "describe" on line 9.\n',
    );
  });
});
