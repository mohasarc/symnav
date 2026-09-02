import type { SymbolIdentity } from "@symnav/core";

export interface TypeScriptSemanticQueryObserver {
  semanticProjectLoaded?(fileCount: number): void;
  semanticCacheReleased?(): void;
  definitionSearch?(identity: SymbolIdentity): void;
  referenceSearch?(identity: SymbolIdentity): void;
  callTargetResolution?(relativePath: string, start: number): void;
}
