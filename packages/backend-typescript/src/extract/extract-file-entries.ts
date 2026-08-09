import type { Node, SourceFile } from "ts-morph";
import {
  assignDisambiguators,
  OverviewTree,
  type DiagnosticSink,
  type OverviewFileEntries,
  type SymbolOverviewNode,
} from "@symnav/core";

import { OverviewChildrenExtractor } from "./extract-overview-children.js";

export function extractFileEntries(args: {
  sourceFile: SourceFile;
  filePath: string;
  diagnostics?: DiagnosticSink | undefined;
  onDeclaration?: (declaration: SymbolOverviewNode, node: Node) => void;
}): OverviewFileEntries {
  const declarationNodes: Node[] = [];
  const extractor = new OverviewChildrenExtractor({
    file: args.filePath,
    diagnostics: args.diagnostics,
    onDeclarationNode: (node) => declarationNodes.push(node),
  });
  const topLevel = extractor.extract(args.sourceFile.getStatements());
  const entries = assignDisambiguators(topLevel);
  const declarations = OverviewTree.walkSymbols(entries);
  if (declarations.length !== declarationNodes.length) {
    throw new Error("declaration origin count does not match extracted symbols");
  }
  declarations.forEach((declaration, index) => {
    args.onDeclaration?.(declaration, declarationNodes[index]!);
  });
  return {
    file: args.filePath,
    entries,
  };
}
