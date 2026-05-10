import type { FileSystem, LanguageBackend, Workspace } from "@symnav/core";

export interface ProgramDependencies {
  fs?: FileSystem;
  backends?: (workspace: Workspace) => readonly LanguageBackend[];
}
