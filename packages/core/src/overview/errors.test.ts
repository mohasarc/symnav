import { describe, expect, it } from "vitest";

import type { OverviewNode } from "../intermediate-representation/overview-tree.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewError,
  AmbiguousOverviewTargetError,
  InvalidOverviewExpansionRequestError,
  OverviewTargetNotFoundError,
} from "./errors.js";
import type { OverviewExpansionCandidate } from "./overview-expansion-result.js";

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

describe("AmbiguousOverviewTargetError", () => {
  it("carries its candidates and names the ambiguity", () => {
    const candidates = [
      candidate('1-3: describe("setup", () => {', 1, 3),
      candidate('5-9: describe("cursor", () => {', 5, 9),
    ];

    const err = new AmbiguousOverviewTargetError(candidates);

    expect(err.candidates).toBe(candidates);
    expect(err.reason).toBe("overview target matches multiple nodes");
  });
});

describe("AmbiguousLineTargetError", () => {
  it("carries its candidates and names the ambiguous line", () => {
    const candidates = [
      candidate('1: describe("alpha", () => {', 1, 1),
      candidate('1: describe("beta", () => {', 1, 1),
    ];

    const err = new AmbiguousLineTargetError(1, candidates);

    expect(err.candidates).toBe(candidates);
    expect(err.line).toBe(1);
    expect(err.reason).toBe("line 1 matches multiple overview nodes");
  });
});

describe("AmbiguousOverviewError", () => {
  it("is the base of both ambiguous overview errors", () => {
    expect(new AmbiguousOverviewTargetError([])).toBeInstanceOf(AmbiguousOverviewError);
    expect(new AmbiguousLineTargetError(1, [])).toBeInstanceOf(AmbiguousOverviewError);
  });
});

describe("OverviewTargetNotFoundError", () => {
  it("names the unmatched header text and line", () => {
    const err = new OverviewTargetNotFoundError({ depth: 0, at: "describe", line: 9 });

    expect(err.request).toEqual({ depth: 0, at: "describe", line: 9 });
    expect(err.reason).toBe('no overview target matching header text "describe" on line 9');
  });

  it("names unmatched header text alone", () => {
    const err = new OverviewTargetNotFoundError({ depth: 0, at: "describe", line: undefined });

    expect(err.reason).toBe('no overview target matching header text "describe"');
  });

  it("names an unmatched line alone", () => {
    const err = new OverviewTargetNotFoundError({ depth: 0, at: undefined, line: 9 });

    expect(err.reason).toBe("no overview target matching line 9");
  });
});

describe("InvalidOverviewExpansionRequestError", () => {
  it("carries the request detail as its reason", () => {
    const err = new InvalidOverviewExpansionRequestError("depth must be a non-negative integer");

    expect(err.reason).toBe("invalid overview request: depth must be a non-negative integer");
  });
});
