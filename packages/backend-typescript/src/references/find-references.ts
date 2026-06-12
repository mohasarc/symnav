import { Node, Project, type ReferencedSymbolEntry, type SourceFile } from "ts-morph";
import {
  SymbolNotFoundError,
  type FileSystem,
  type Reference,
  type ResolvedPath,
  type SymbolIdentity,
} from "@symnav/core";

import { locateDeclarationsMatchingIdentity } from "../identity/locate-declarations.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";
import { classifyReferenceKind } from "./classify-reference-kind.js";

export interface FindReferencesArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findReferences(args: FindReferencesArgs): Promise<readonly Reference[]> {
  return new ReferenceFinder(args).find();
}

class ReferenceFinder {
  private readonly project: Project;
  private readonly relativePathByAbsolute = new Map<string, string>();

  constructor(private readonly args: FindReferencesArgs) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(args.fs) });
  }

  async find(): Promise<readonly Reference[]> {
    this.loadWorkspaceFiles();
    const declarationNodes = this.declarationNodesMatchingIdentity();
    if (declarationNodes.length === 0) throw new SymbolNotFoundError(this.args.identity);
    return this.referencesFrom(declarationNodes);
  }

  private loadWorkspaceFiles(): void {
    for (const path of this.args.files) {
      this.project.addSourceFileAtPath(path.absolute);
      this.relativePathByAbsolute.set(path.absolute, path.relative);
    }
  }

  private declarationNodesMatchingIdentity(): readonly Node[] {
    const targetSource = this.targetSourceFile();
    if (!targetSource) return [];
    return locateDeclarationsMatchingIdentity(targetSource, this.args.identity).map(
      (located) => located.node,
    );
  }

  private targetSourceFile(): SourceFile | undefined {
    for (const path of this.args.files) {
      if (path.relative === this.args.identity.file) {
        return this.project.getSourceFile(path.absolute);
      }
    }
    return undefined;
  }

  private referencesFrom(declarationNodes: readonly Node[]): Reference[] {
    const out: Reference[] = [];
    const seen = new Set<string>();
    for (const declarationNode of declarationNodes) {
      for (const entry of referenceEntriesOf(declarationNode)) {
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

  private toReference(entry: ReferencedSymbolEntry): Reference | undefined {
    const node = entry.getNode();
    const sourceFile = node.getSourceFile();
    const relative = this.relativePathByAbsolute.get(sourceFile.getFilePath());
    if (!relative) return undefined;
    const { line, character } = sourceFile.compilerNode.getLineAndCharacterOfPosition(
      node.getStart(),
    );
    return {
      file: relative,
      line: line + 1,
      previewSource: lineText(sourceFile, line),
      matchStart: character,
      matchEnd: character + node.getWidth(),
      kind: classifyReferenceKind(node),
    };
  }
}

function referenceEntriesOf(declarationNode: Node): readonly ReferencedSymbolEntry[] {
  if (!Node.isReferenceFindable(declarationNode)) return [];
  return declarationNode
    .findReferences()
    .flatMap((referencedSymbol) => referencedSymbol.getReferences())
    .filter((entry) => !entry.isDefinition());
}

function lineText(sourceFile: SourceFile, zeroBasedLine: number): string {
  const fullText = sourceFile.getFullText();
  const lineStarts = sourceFile.compilerNode.getLineStarts();
  const start = lineStarts[zeroBasedLine] ?? 0;
  const end =
    zeroBasedLine + 1 < lineStarts.length ? lineStarts[zeroBasedLine + 1]! : fullText.length;
  return fullText.slice(start, end).replace(/\r?\n$/, "");
}
