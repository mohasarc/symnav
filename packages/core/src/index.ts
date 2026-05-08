export type { SymbolKind, LineRange, SymbolDecl, FileSymbols } from "./ir.js";
export { buildSymbolPath } from "./symbol-path.js";
export type { WorkspaceFileSystem } from "./file-system.js";
export type { Workspace, CreateWorkspaceOptions } from "./workspace.js";
export { createWorkspace, nodeFileSystem } from "./workspace.js";
export { NotInWorkspaceError } from "./errors.js";
