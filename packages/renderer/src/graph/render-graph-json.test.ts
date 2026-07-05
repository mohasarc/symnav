import { describe, expect, it } from "vitest";

import { decl, path, result, step } from "./graph-renderer-test-helpers.js";
import { renderGraphJson } from "./render-graph-json.js";

describe("renderGraphJson", () => {
  it("round-trips graph result fields", () => {
    const root = decl({
      file: "src/root.ts",
      segments: [{ name: "root" }],
      startLine: 1,
      endLine: 4,
      signature: ["function root()"],
    });
    const caller = decl({
      file: "src/caller.ts",
      segments: [{ name: "caller" }],
      startLine: 8,
      endLine: 12,
      signature: ["function caller()"],
    });
    const graph = result(root, {
      direction: "incoming",
      incoming: { paths: [path(step(caller))], totalPathCount: 1 },
      outgoing: undefined,
      page: 2,
      pageCount: 3,
      repeatedSymbolCount: 1,
    });

    expect(JSON.parse(renderGraphJson(graph))).toEqual(graph);
  });
});
