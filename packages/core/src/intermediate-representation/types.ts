import type { SymbolIdentity } from "./symbol-identity.js";
import type { NavigationDiagnostic } from "../diagnostics/navigation-diagnostic.js";
import type {
  OverviewFileSymbols as OverviewTreeFileSymbols,
  SymbolOverviewNode,
} from "./overview-tree.js";

export type SymbolRole = "container" | "callable" | "value" | "type";

export interface SymbolKind {
  readonly role: SymbolRole;
  readonly nativeLabel: string;
}

export interface LineRange {
  readonly startLine: number; // 1-based, inclusive
  readonly endLine: number; // 1-based, inclusive; equals startLine for single-line decls
}

export interface Signature {
  readonly startLine: number; // 1-based source line of lines[0]
  readonly lines: readonly string[]; // each element single-line, no "\n"
}

export type SymbolDecl = SymbolOverviewNode;

export interface ResultWithDiagnostics {
  readonly diagnostics?: readonly NavigationDiagnostic[];
}

export type OverviewFileSymbols = OverviewTreeFileSymbols;

export interface ResolveResult {
  readonly query: string;
  readonly fuzzy: boolean;
  readonly symbols: readonly SymbolDecl[];
  readonly files: readonly string[];
}

export interface DefinitionResult {
  readonly identity: SymbolIdentity;
  readonly symbols: readonly SymbolDecl[];
}
