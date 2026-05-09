export type { SymbolKind, LineRange, SymbolDecl, FileSymbols } from "./ir.js";
export { buildSymbolPath } from "./symbol-path.js";
export type { WorkspaceFileSystem } from "./file-system.js";
export { NodeFileSystem } from "./file-system.js";
export type { Workspace } from "./workspace.js";
export { AbstractWorkspace } from "./abstract-workspace.js";
export type { IgnoreScope } from "./ignore-scope.js";
export { NodeWorkspace } from "./node-workspace.js";
export { NotInWorkspaceError } from "./errors.js";
