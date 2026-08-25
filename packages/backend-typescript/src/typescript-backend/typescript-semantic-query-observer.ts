import type { SymbolIdentity } from "@symnav/core";

export interface TypeScriptSemanticQueryObserver {
  semanticProjectLoaded?(fileCount: number): void;
  referenceSearch?(identity: SymbolIdentity): void;
  callTargetResolution?(relativePath: string, start: number): void;
}
