import type { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { NodeLineNumbers } from "./node-line-numbers.js";

describe("NodeLineNumbers", () => {
  it.each([
    ["line feeds", "\n"],
    ["carriage return line feeds", "\r\n"],
    ["lone carriage returns", "\r"],
    ["line separators", " "],
  ])("matches ts-morph start and end lines across %s", (_name, lineBreak) => {
    const sourceFile = parseTypeScriptSource(
      [
        "/** docs */",
        "export function first(value: number): number {",
        "  return value;",
        "}",
        "",
        'export { first as second } from "./first";',
        "class Holder { method(): void {} }",
      ].join(lineBreak),
    );
    const nodes: Node[] = [];
    sourceFile.forEachDescendant((node) => {
      nodes.push(node);
    });

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect([NodeLineNumbers.startLine(node), NodeLineNumbers.endLine(node)]).toEqual([
        node.getStartLineNumber(),
        node.getEndLineNumber(),
      ]);
    }
  });
});
