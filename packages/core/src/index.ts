export type {
  SymbolKind,
  LineRange,
  SymbolDecl,
  FileSymbols,
} from "./intermediate-representation/types.js";
export { buildSymbolPath } from "./intermediate-representation/symbol-path.js";
export type { FileSystem } from "./workspace/file-system.js";
export { NodeFileSystem } from "./workspace/node-file-system.js";
export type { Workspace } from "./workspace/workspace.js";
export { AbstractWorkspace } from "./workspace/abstract-workspace.js";
export type { IgnoreScope } from "./workspace/ignore/scope.js";
export { NodeWorkspace } from "./workspace/node-workspace.js";
export type { LanguageBackend } from "./backend/language-backend.js";
export { BackendRouter } from "./backend/backend-router.js";
export {
  BackendError,
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "./backend/errors.js";
export { NotInWorkspaceError } from "./workspace/errors.js";
export { runOverview } from "./commands/overview.js";
