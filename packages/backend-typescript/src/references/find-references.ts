import { Node, type ReferencedSymbolEntry, type SourceFile } from "ts-morph";
import {
  SymbolNotFoundError,
  type SymbolReference,
  type ResolvedPath,
  type SymbolIdentity,
} from "@symnav/core";

import type { TypeScriptWorkspaceState } from "../typescript-backend/typescript-workspace-state.js";
import { classifyReferenceKind } from "./classify-reference-kind.js";

export interface FindReferencesArgs {
  readonly state: TypeScriptWorkspaceState;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export class ReferenceFinder {
  public constructor(private readonly args: FindReferencesArgs) {}

  public async find(): Promise<readonly SymbolReference[]> {
    this.args.state.ensureFiles(this.args.files);
    const declarationNodes = this.declarationNodesMatchingIdentity();
    if (declarationNodes.length === 0) throw new SymbolNotFoundError(this.args.identity);
    return this.referencesFrom(declarationNodes);
  }

  private declarationNodesMatchingIdentity(): readonly Node[] {
    return this.args.state.locateSemanticCopies(this.args.identity).map((located) => located.node);
  }

  private referencesFrom(declarationNodes: readonly Node[]): SymbolReference[] {
    const out: SymbolReference[] = [];
    const seen = new Set<string>();
    for (const declarationNode of declarationNodes) {
      for (const entry of this.referenceEntriesOf(declarationNode)) {
        const reference = this.toReference(entry);
        if (!reference) continue;
        const key = `${reference.file}:${reference.line}:${reference.matchStart}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(reference);
      }
    }
    return out;
  }

  private toReference(entry: ReferencedSymbolEntry): SymbolReference | undefined {
    const node = entry.getNode();
    const sourceFile = node.getSourceFile();
    const relative = this.args.state.relativePathOf(sourceFile);
    if (!relative) return undefined;
    const { line, character } = sourceFile.compilerNode.getLineAndCharacterOfPosition(
      node.getStart(),
    );
    return {
      file: relative,
      line: line + 1,
      previewSource: this.lineText(sourceFile, line),
      matchStart: character,
      matchEnd: character + node.getWidth(),
      kind: classifyReferenceKind(node),
    };
  }

  private referenceEntriesOf(declarationNode: Node): readonly ReferencedSymbolEntry[] {
    if (!Node.isReferenceFindable(declarationNode)) return [];
    return declarationNode
      .findReferences()
      .flatMap((referencedSymbol) => referencedSymbol.getReferences())
      .filter((entry) => !entry.isDefinition());
  }

  private lineText(sourceFile: SourceFile, zeroBasedLine: number): string {
    const fullText = sourceFile.getFullText();
    const lineStarts = sourceFile.compilerNode.getLineStarts();
    const start = lineStarts[zeroBasedLine] ?? 0;
    const end =
      zeroBasedLine + 1 < lineStarts.length ? lineStarts[zeroBasedLine + 1]! : fullText.length;
    return fullText.slice(start, end).replace(/\r?\n$/, "");
  }
}
