import type { FileSystem, LanguageBackend } from "@symnav/core";

export interface ProgramDependencies {
  fs: FileSystem;
  backends: () => readonly LanguageBackend[];
}
