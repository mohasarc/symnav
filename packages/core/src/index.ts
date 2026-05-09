export type { SymbolKind, LineRange, SymbolDecl, FileSymbols } from "./ir.js";
export { buildSymbolPath } from "./symbol-path.js";
export type { WorkspaceFileSystem } from "./file-system.js";
export type { Workspace, CreateWorkspaceOptions, IgnoreScope } from "./workspace.js";
export { createWorkspace, NodeFileSystem, AbstractWorkspace } from "./workspace.js";
export { NotInWorkspaceError } from "./errors.js";
