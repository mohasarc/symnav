export type {
  SymbolKind,
  LineRange,
  SymbolDecl,
  FileSymbols,
} from "./intermediate-representation/types.js";
export { buildSymbolPath } from "./intermediate-representation/symbol-path.js";
export type { WorkspaceFileSystem } from "./workspace-file-system.js";
export { NodeFileSystem } from "./node-file-system.js";
export type { Workspace } from "./workspace.js";
export { AbstractWorkspace } from "./abstract-workspace.js";
export type { IgnoreScope } from "./ignore-scope.js";
export { NodeWorkspace } from "./node-workspace.js";
export { NotInWorkspaceError } from "./errors.js";
