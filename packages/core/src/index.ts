export type {
  SymbolRole,
  SymbolKind,
  LineRange,
  Signature,
  SymbolDecl,
  OverviewFileSymbols,
  ResolveResult,
  DefinitionResult,
} from "./intermediate-representation/types.js";
export type {
  SymbolPathSegment,
  SymbolIdentity,
} from "./intermediate-representation/symbol-identity.js";
export type {
  ReferenceKind,
  SymbolReference,
  RefsResult,
} from "./intermediate-representation/references.js";
export type { SourceMatch } from "./intermediate-representation/source-match.js";
export type { CallTargetResolution } from "./intermediate-representation/call-target.js";
export type { HistoryEntry, RecentHistoryQuery, GitHistory } from "./git/git-history.js";
export type {
  EdgeConfidence,
  CallSite,
  CallEdge,
} from "./intermediate-representation/call-edge.js";
export type { BuildRefsResultArgs } from "./intermediate-representation/refs-result-builder.js";
export { RefsResultBuilder } from "./intermediate-representation/refs-result-builder.js";
export { countReferenceKinds } from "./intermediate-representation/reference-kinds.js";
export type { PageRequest, Page } from "./pagination/paginator.js";
export { DEFAULT_PAGE_SIZE, Paginator } from "./pagination/paginator.js";
export { InvalidPageRequestError, PageOutOfRangeError } from "./pagination/errors.js";
export { isPositiveInteger } from "./validation/is-positive-integer.js";
export {
  InvalidSymbolIdError,
  formatSymbolIdentity,
  parseSymbolIdentity,
} from "./intermediate-representation/canonical-identity.js";
export { splitSignatureLines } from "./intermediate-representation/split-signature-lines.js";
export { assignDisambiguators } from "./intermediate-representation/assign-disambiguators.js";
export type { FileSystem } from "./workspace/file-system.js";
export { NodeFileSystem } from "./workspace/node-file-system.js";
export type { ResolvedPath, Workspace } from "./workspace/workspace.js";
export { createWorkspace } from "./workspace/workspace.js";
export { InMemoryFileSystem } from "./workspace/in-memory/in-memory-file-system.js";
export type { LanguageBackend, ResolveSymbolsOptions } from "./backend/language-backend.js";
export { BackendRouter } from "./backend/backend-router.js";
export { UserFacingError } from "./errors.js";
export { SymbolNotFoundError, UnsupportedFileError } from "./backend/errors.js";
export { FileNotFoundError, OutsideWorkspaceError } from "./workspace/errors.js";
