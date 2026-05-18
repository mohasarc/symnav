export type {
  SymbolRole,
  SymbolKind,
  LineRange,
  Signature,
  SymbolDecl,
  FileSymbols,
} from "./intermediate-representation/types.js";
export type {
  SymbolPathSegment,
  SymbolIdentity,
} from "./intermediate-representation/symbol-identity.js";
export { buildSymbolPath } from "./intermediate-representation/symbol-path.js";
export { splitSignatureLines } from "./intermediate-representation/split-signature-lines.js";
export type { FileSystem } from "./workspace/file-system.js";
export { NodeFileSystem } from "./workspace/node-file-system.js";
export type { ResolvedPath, Workspace } from "./workspace/workspace.js";
export { createWorkspace } from "./workspace/workspace.js";
export { InMemoryFileSystem } from "./workspace/in-memory/in-memory-file-system.js";
export type { LanguageBackend } from "./backend/language-backend.js";
export { BackendRouter } from "./backend/backend-router.js";
export { UserFacingError } from "./errors.js";
export { UnsupportedFileError } from "./backend/errors.js";
export { FileNotFoundError, OutsideWorkspaceError } from "./workspace/errors.js";
