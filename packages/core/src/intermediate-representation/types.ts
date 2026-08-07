import type { SymbolIdentity } from "./symbol-identity.js";
import type { ResolveSymbolsMode } from "../backend/language-backend.js";
import type { NavigationDiagnostic } from "../diagnostics/navigation-diagnostic.js";
import type { SymbolOverviewNode } from "./overview-tree.js";

export type SymbolRole = "container" | "callable" | "value" | "type";

export interface SymbolKind {
  readonly role: SymbolRole;
  readonly nativeLabel: string;
}

export interface LineRange {
  readonly startLine: number; // 1-based, inclusive
  readonly endLine: number; // 1-based, inclusive; equals startLine for single-line decls
}

export interface Header {
  readonly startLine: number; // 1-based source line of lines[0]
  readonly lines: readonly string[]; // each element single-line, no "\n"
}

export interface ResultWithDiagnostics {
  readonly diagnostics?: readonly NavigationDiagnostic[];
}

export interface ResolveResult extends ResultWithDiagnostics {
  readonly query: string;
  readonly mode: ResolveSymbolsMode;
  readonly symbols: readonly SymbolOverviewNode[];
  readonly files: readonly string[];
}

export interface DefinitionResult extends ResultWithDiagnostics {
  readonly identity: SymbolIdentity;
  readonly symbols: readonly SymbolOverviewNode[];
}
