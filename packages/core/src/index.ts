export type { SymbolKind, LineRange, SymbolDecl, FileSymbols } from "./ir.js";
export { buildSymbolPath } from "./symbol-path.js";
export type { WorkspaceFileSystem } from "./file-system.js";
export type { Workspace, IgnoreScope } from "./workspace.js";
export { NodeFileSystem, AbstractWorkspace } from "./workspace.js";
export { NodeWorkspace } from "./node-workspace.js";
export { NotInWorkspaceError } from "./errors.js";
