export type {
  SymbolRole,
  SymbolKind,
  LineRange,
  Header,
  ResultWithDiagnostics,
  ResolveResult,
  DefinitionResult,
} from "./intermediate-representation/types.js";
export type {
  FoldOverviewNode,
  OverviewFileEntries,
  OverviewNode,
  OverviewNodeBase,
  ReExportOverviewNode,
  SymbolOverviewNode,
} from "./intermediate-representation/overview-tree.js";
export { OverviewTree } from "./intermediate-representation/overview-tree.js";
export type {
  OverviewExpansionCandidate,
  OverviewExpansionRequest,
  OverviewExpansionResult,
} from "./overview/overview-expansion-result.js";
export {
  AmbiguousLineTargetError,
  AmbiguousOverviewError,
  AmbiguousOverviewTargetError,
  InvalidOverviewExpansionRequestError,
  OverviewTargetNotFoundError,
} from "./overview/errors.js";
export type { ExpandOverviewArgs } from "./overview/overview-expander.js";
export { OverviewExpander } from "./overview/overview-expander.js";
export type {
  NavigationDiagnosticSeverity,
  NavigationDiagnostic,
  DiagnosticSink,
} from "./diagnostics/navigation-diagnostic.js";
export { CollectingDiagnosticSink } from "./diagnostics/navigation-diagnostic.js";
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
export type { GraphPathStep, GraphPath } from "./graph/graph-path.js";
export { DEFAULT_GRAPH_DEPTH, MAX_GRAPH_DEPTH } from "./graph/graph-path.js";
export { GraphDepthExceededError, InvalidGraphRequestError } from "./graph/errors.js";
export type { GraphTraverserArgs } from "./graph/graph-traverser.js";
export { GraphTraverser } from "./graph/graph-traverser.js";
export type {
  GraphDirection,
  GraphDirectionPage,
  GraphResult,
} from "./intermediate-representation/graph-result.js";
export type { BuildGraphResultArgs } from "./intermediate-representation/graph-result-builder.js";
export { GraphResultBuilder } from "./intermediate-representation/graph-result-builder.js";
export type { BuildRefsResultArgs } from "./intermediate-representation/refs-result-builder.js";
export { RefsResultBuilder } from "./intermediate-representation/refs-result-builder.js";
export type {
  CappedCertainCallEdges,
  ContextReferenceSummary,
  ContextResult,
} from "./intermediate-representation/context-result.js";
export { DEFAULT_CONTEXT_CAP } from "./intermediate-representation/context-result.js";
export type { BuildContextResultArgs } from "./intermediate-representation/context-result-builder.js";
export { ContextResultBuilder } from "./intermediate-representation/context-result-builder.js";
export type { PageRequest, Page } from "./pagination/paginator.js";
export { DEFAULT_PAGE_SIZE, Paginator } from "./pagination/paginator.js";
export { InvalidPageRequestError, PageOutOfRangeError } from "./pagination/errors.js";
export { isPositiveInteger } from "./validation/is-positive-integer.js";
export {
  InvalidSymbolIdError,
  formatSymbolIdentity,
  formatSymbolPath,
  parseSymbolIdentity,
} from "./intermediate-representation/canonical-identity.js";
export { splitHeaderLines } from "./intermediate-representation/split-header-lines.js";
export { assignDisambiguators } from "./intermediate-representation/assign-disambiguators.js";
export type { FileSystem } from "./workspace/file-system.js";
export { NodeFileSystem } from "./workspace/node-file-system.js";
export type { ResolvedPath, Workspace } from "./workspace/workspace.js";
export { createWorkspace } from "./workspace/workspace.js";
export { InMemoryFileSystem } from "./workspace/in-memory/in-memory-file-system.js";
export type { LanguageBackend, ResolveSymbolsOptions } from "./backend/language-backend.js";
export { BackendRouter } from "./backend/backend-router.js";
export { UserFacingError } from "./errors.js";
export {
  AmbiguousSymbolError,
  SymbolNotFoundError,
  UnsupportedFileError,
} from "./backend/errors.js";
export { FileNotFoundError, OutsideWorkspaceError } from "./workspace/errors.js";
export { DirectoryInputError } from "./workspace/errors.js";
