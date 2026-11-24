import type { SourceFile } from "ts-morph";
import type { DiagnosticSink, OverviewFileEntries } from "@symnav/core";

import { FileDeclarationExtraction } from "./file-declaration-extraction.js";

export function extractFileEntries(args: {
  sourceFile: SourceFile;
  filePath: string;
  diagnostics?: DiagnosticSink | undefined;
}): OverviewFileEntries {
  return FileDeclarationExtraction.extract(args).entries;
}
