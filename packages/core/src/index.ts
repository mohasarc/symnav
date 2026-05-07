export type { SymbolKind, LineRange, SymbolDecl, FileSymbols } from "./ir.js";
export { buildSymbolPath } from "./symbol-path.js";
export type { WorkspaceFileSystem } from "./file-system.js";
export { nodeFileSystem } from "./file-system.js";
export type { Workspace, CreateWorkspaceOptions } from "./workspace.js";
export { createWorkspace } from "./workspace.js";
export type { LanguageBackend } from "./backend.js";
export { BackendRouter } from "./backend.js";
export {
  NotInWorkspaceError,
  BackendError,
  FileNotFoundError,
  OutsideWorkspaceError,
  IgnoredFileError,
  UnsupportedFileError,
} from "./errors.js";
