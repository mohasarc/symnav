import {
  SymbolNotFoundError,
  TurnScopedCacheScope,
  formatSymbolIdentity,
  type CallEdge,
  type CallTargetResolution,
  type SymbolIdentity,
  type SymbolOverviewNode,
  type SymbolReference,
  type WorkspaceFile,
} from "@symnav/core";
import { Node, type ReferencedSymbolEntry, type SourceFile } from "ts-morph";

import { CallerFinder } from "../call-graph/find-callers.js";
import { findCallees, type PositionDefinitionResolver } from "../call-graph/find-callees.js";
import { findDefinitions } from "../definition/find-definitions.js";
import { classifyReferenceKind } from "../references/classify-reference-kind.js";
import type { TypeScriptProjectGraph } from "./typescript-project-graph.js";
import type { TypeScriptSemanticQueryObserver } from "./typescript-semantic-query-observer.js";
import type { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

export interface SemanticReferenceLocation {
  readonly relativePath: string;
  readonly start: number;
  readonly length: number;
  readonly isDefinition: boolean;
}

export class TypeScriptSemanticQueryService implements PositionDefinitionResolver {
  private files: readonly WorkspaceFile[] = [];
  private readonly cacheScope = new TurnScopedCacheScope();
  private readonly definitionsByIdentity = this.cacheScope.createCache<
    string,
    Promise<readonly SymbolOverviewNode[]>
  >();
  private readonly referencesByIdentity = this.cacheScope.createCache<
    string,
    Promise<readonly SemanticReferenceLocation[]>
  >();
  private readonly callTargetsByIdentity = this.cacheScope.createCache<
    string,
    Promise<CallTargetResolution>
  >();
  private readonly callersByIdentity = this.cacheScope.createCache<
    string,
    Promise<readonly CallEdge[]>
  >();
  private readonly calleesByIdentity = this.cacheScope.createCache<
    string,
    Promise<readonly CallEdge[]>
  >();
  private readonly definitionsByPosition = this.cacheScope.createCache<
    string,
    readonly SemanticNodeLocation[]
  >();

  constructor(
    private readonly projects: TypeScriptProjectGraph | undefined,
    private readonly workspaceState: TypeScriptWorkspaceState,
    private readonly observer?: TypeScriptSemanticQueryObserver,
  ) {}

  beginTurn(files: readonly WorkspaceFile[]): void {
    this.files = files;
    this.cacheScope.beginTurn();
  }

  findDefinitions(identity: SymbolIdentity): Promise<readonly SymbolOverviewNode[]> {
    const key = formatSymbolIdentity(identity);
    return this.definitionsByIdentity.getOrCreate(key, () => {
      this.observer?.definitionSearch?.(identity);
      return findDefinitions({
        workspaceState: this.workspaceState,
        files: this.files,
        identity,
      });
    });
  }

  async findReferences(identity: SymbolIdentity): Promise<readonly SymbolReference[]> {
    const locations = await this.referenceLocations(identity);
    return locations.flatMap((location) => {
      if (location.isDefinition) return [];
      const node = this.workspaceState.nodeAt(location.relativePath, location.start);
      if (!node) return [];
      const sourceFile = node.getSourceFile();
      const { line, character } = sourceFile.compilerNode.getLineAndCharacterOfPosition(
        location.start,
      );
      return [
        {
          file: location.relativePath,
          line: line + 1,
          previewSource: TypeScriptSemanticQueryService.lineText(sourceFile, line),
          matchStart: character,
          matchEnd: character + location.length,
          kind: classifyReferenceKind(node),
        },
      ];
    });
  }

  findCallTarget(identity: SymbolIdentity): Promise<CallTargetResolution> {
    const key = formatSymbolIdentity(identity);
    return this.callTargetsByIdentity.getOrCreate(key, () => this.resolveCallTarget(identity));
  }

  findCallers(identity: SymbolIdentity): Promise<readonly CallEdge[]> {
    const key = formatSymbolIdentity(identity);
    return this.callersByIdentity.getOrCreate(key, () =>
      this.referenceLocations(identity).then((locations) =>
        new CallerFinder(this.workspaceState).find(locations),
      ),
    );
  }

  findCallees(identity: SymbolIdentity): Promise<readonly CallEdge[]> {
    const key = formatSymbolIdentity(identity);
    return this.calleesByIdentity.getOrCreate(key, () =>
      findCallees({
        workspaceState: this.workspaceState,
        files: this.files,
        identity,
        definitionResolver: this,
      }),
    );
  }

  async releaseTransientResources(): Promise<void> {
    this.cacheScope.releaseTransientResources();
    await this.projects?.releaseTransientResources();
  }

  definitionNodesOf(node: Node): readonly Node[] {
    if (!Node.isIdentifier(node) && !Node.isPrivateIdentifier(node)) return [];
    const relativePath = this.workspaceState.relativePathOf(node.getSourceFile());
    if (!relativePath) return [];
    const key = `${relativePath}:${node.getStart()}`;
    const locations = this.definitionsByPosition.getOrCreate(key, () => {
      this.observer?.callTargetResolution?.(relativePath, node.getStart());
      return node.getDefinitionNodes().flatMap((definition) => {
        const definitionRelativePath = this.workspaceState.relativePathOf(
          definition.getSourceFile(),
        );
        return definitionRelativePath
          ? [
              {
                relativePath: definitionRelativePath,
                start: definition.getStart(),
                kind: definition.getKind(),
              },
            ]
          : [];
      });
    });
    return locations.flatMap((location) => {
      const sourceFile = this.projects?.sourceFileFor(location.relativePath);
      const definition = this.nodeAtSemanticLocation(location, sourceFile);
      return definition ? [definition] : [];
    });
  }

  private referenceLocations(
    identity: SymbolIdentity,
  ): Promise<readonly SemanticReferenceLocation[]> {
    const key = formatSymbolIdentity(identity);
    return this.referencesByIdentity.getOrCreate(key, () => {
      this.observer?.referenceSearch?.(identity);
      return Promise.resolve(this.findReferenceLocations(identity));
    });
  }

  private findReferenceLocations(identity: SymbolIdentity): readonly SemanticReferenceLocation[] {
    const declarationNodes = this.workspaceState
      .locateSemanticCopies(identity)
      .map((located) => located.node);
    if (declarationNodes.length === 0) throw new SymbolNotFoundError(identity);
    const locations = declarationNodes.flatMap((declarationNode) =>
      TypeScriptSemanticQueryService.referenceEntriesOf(declarationNode).flatMap((entry) => {
        const node = entry.getNode();
        const relativePath = this.workspaceState.relativePathOf(node.getSourceFile());
        return relativePath
          ? [
              {
                relativePath,
                start: node.getStart(),
                length: node.getWidth(),
                isDefinition: entry.isDefinition() ?? false,
              },
            ]
          : [];
      }),
    );
    const byLocation = new Map<string, SemanticReferenceLocation>();
    for (const location of locations) {
      byLocation.set(
        `${location.relativePath}:${location.start}:${location.length}:${location.isDefinition}`,
        location,
      );
    }
    return [...byLocation.values()];
  }

  private async resolveCallTarget(identity: SymbolIdentity): Promise<CallTargetResolution> {
    const definitions = await this.findDefinitions(identity);
    if (definitions.length === 0) return { outcome: "not-found" };
    const implementations = definitions.filter((definition) =>
      definition.kind.nativeLabel.endsWith("-implementation"),
    );
    if (implementations.length > 1) {
      return { outcome: "ambiguous", candidates: implementations };
    }
    if (implementations.length === 1) {
      return { outcome: "resolved", target: implementations[0]! };
    }
    return { outcome: "resolved", target: definitions[0]! };
  }

  private nodeAtSemanticLocation(
    location: SemanticNodeLocation,
    sourceFile: SourceFile | undefined,
  ): Node | undefined {
    let node =
      sourceFile?.getDescendantAtPos(location.start) ??
      this.workspaceState.nodeAt(location.relativePath, location.start);
    while (node) {
      if (node.getStart() === location.start && node.getKind() === location.kind) return node;
      node = node.getParent();
    }
    return undefined;
  }

  private static referenceEntriesOf(declarationNode: Node): readonly ReferencedSymbolEntry[] {
    if (!Node.isReferenceFindable(declarationNode)) return [];
    return declarationNode
      .findReferences()
      .flatMap((referencedSymbol) => referencedSymbol.getReferences());
  }

  private static lineText(sourceFile: SourceFile, zeroBasedLine: number): string {
    const fullText = sourceFile.getFullText();
    const lineStarts = sourceFile.compilerNode.getLineStarts();
    const start = lineStarts[zeroBasedLine] ?? 0;
    const end =
      zeroBasedLine + 1 < lineStarts.length ? lineStarts[zeroBasedLine + 1]! : fullText.length;
    return fullText.slice(start, end).replace(/\r?\n$/, "");
  }
}

interface SemanticNodeLocation {
  readonly relativePath: string;
  readonly start: number;
  readonly kind: number;
}
