import type { Node, SourceFile } from "ts-morph";
import {
  OverviewTree,
  assignDisambiguators,
  type DiagnosticSink,
  type OverviewFileEntries,
  type SymbolOverviewNode,
} from "@symnav/core";

import { OverviewChildrenExtractor } from "./extract-overview-children.js";

export class FileDeclarationExtraction {
  private constructor(
    readonly entries: OverviewFileEntries,
    readonly declarationNodes: ReadonlyMap<SymbolOverviewNode, Node>,
  ) {}

  static extract(args: {
    sourceFile: SourceFile;
    filePath: string;
    diagnostics?: DiagnosticSink | undefined;
  }): FileDeclarationExtraction {
    const extractor = new OverviewChildrenExtractor({
      file: args.filePath,
      diagnostics: args.diagnostics,
    });
    const extracted = extractor.extract(args.sourceFile.getStatements());
    const entries = assignDisambiguators(extracted);
    const extractedSymbols = OverviewTree.walkSymbols(extracted);
    const declarationNodes = new Map<SymbolOverviewNode, Node>();
    OverviewTree.walkSymbols(entries).forEach((symbol, index) => {
      const extractedSymbol = extractedSymbols[index];
      const node = extractedSymbol && extractor.declarationNodeOf(extractedSymbol);
      if (node) declarationNodes.set(symbol, node);
    });
    return new FileDeclarationExtraction({ file: args.filePath, entries }, declarationNodes);
  }
}
