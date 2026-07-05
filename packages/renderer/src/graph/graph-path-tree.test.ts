import { describe, expect, it } from "vitest";

import { buildGraphPathTree } from "./graph-path-tree.js";
import { decl, path, step } from "./graph-renderer-test-helpers.js";

describe("buildGraphPathTree", () => {
  it("merges paths with the same first step and preserves first occurrence order", () => {
    const shared = decl({
      file: "src/shared.ts",
      segments: [{ name: "shared" }],
      startLine: 1,
      endLine: 3,
      signature: ["function shared()"],
    });
    const first = decl({
      file: "src/first.ts",
      segments: [{ name: "first" }],
      startLine: 5,
      endLine: 7,
      signature: ["function first()"],
    });
    const second = decl({
      file: "src/second.ts",
      segments: [{ name: "second" }],
      startLine: 9,
      endLine: 11,
      signature: ["function second()"],
    });

    const tree = buildGraphPathTree([
      path(step(shared), step(first)),
      path(step(shared), step(second)),
    ]);

    expect(tree).toEqual([
      {
        step: step(shared),
        children: [
          { step: step(first), children: [] },
          { step: step(second), children: [] },
        ],
      },
    ]);
  });

  it("does not attach children to a cycle-closing step", () => {
    const cycle = decl({
      file: "src/cycle.ts",
      segments: [{ name: "cycle" }],
      startLine: 1,
      endLine: 1,
      signature: ["function cycle()"],
    });
    const unreachable = decl({
      file: "src/unreachable.ts",
      segments: [{ name: "unreachable" }],
      startLine: 2,
      endLine: 2,
      signature: ["function unreachable()"],
    });

    const tree = buildGraphPathTree([path(step(cycle, { closesCycle: true }), step(unreachable))]);

    expect(tree).toEqual([{ step: step(cycle, { closesCycle: true }), children: [] }]);
  });
});
