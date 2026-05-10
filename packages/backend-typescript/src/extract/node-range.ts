import type { Node } from "ts-morph";
import type { LineRange } from "@symnav/core";

export function nodeRange(node: Node): LineRange {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  };
}
