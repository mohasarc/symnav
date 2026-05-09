export type {
  SymbolKind,
  LineRange,
  SymbolDecl,
  FileSymbols,
} from "./intermediate-representation/types.js";
export { buildSymbolPath } from "./intermediate-representation/symbol-path.js";
export type { WorkspaceFileSystem } from "./workspace/file-system.js";
export { NodeFileSystem } from "./workspace/node-file-system.js";
export type { Workspace } from "./workspace/workspace.js";
export { AbstractWorkspace } from "./workspace/abstract-workspace.js";
export type { IgnoreScope } from "./workspace/ignore-scope.js";
export { NodeWorkspace } from "./workspace/node-workspace.js";
export { NotInWorkspaceError } from "./workspace/errors.js";
