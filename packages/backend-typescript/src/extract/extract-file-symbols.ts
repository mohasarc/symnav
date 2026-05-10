import type { SourceFile } from "ts-morph";
import type { FileSymbols } from "@symnav/core";

import { extractTopLevel } from "./extract-top-level.js";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): FileSymbols {
  return {
    filePath: args.filePath,
    symbols: extractTopLevel(args.sourceFile),
  };
}
