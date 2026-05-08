import { FileNotFoundError } from "@symnav/core";
import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";
import { Project } from "ts-morph";
import { extractFileSymbols } from "./extract.js";
import { fileSystemHostFromWorkspace } from "./file-system-host.js";

/**
 * File extensions the TypeScript backend claims. Matched case-insensitively.
 *
 * Order matters: `.d.ts` precedes `.ts` so that ambient declaration files are
 * not mis-matched on the bare `.ts` extension first.
 */
export const TS_EXTENSIONS = [".d.ts", ".tsx", ".mts", ".cts", ".ts"] as const;

/**
 * Disk-aware adapter that fulfills the `LanguageBackend` contract for
 * TypeScript files. Reads source through `Workspace.fs` so the same backend
 * works against the real filesystem in production and an in-memory map in
 * tests.
 *
 * Stage 1 runs ts-morph in single-file mode: no `tsconfig.json` is loaded and
 * cross-file resolution is out of scope. A fresh ts-morph `Project` is built
 * per `fileSymbols` call (cold-per-invocation) — Stage 2 introduces tsconfig
 * loading and project caching.
 */
export class TypeScriptBackend implements LanguageBackend {
  constructor(private readonly workspace: Workspace) {}

  accepts(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return TS_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  async fileSymbols(filePath: string): Promise<FileSymbols> {
    const absPath = this.workspace.toAbsolute(filePath);
    if (!this.workspace.fs.existsSync(absPath)) {
      throw new FileNotFoundError(filePath);
    }
    const project = new Project({
      useInMemoryFileSystem: false,
      fileSystem: fileSystemHostFromWorkspace(this.workspace.fs),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
    });
    const sourceFile = project.addSourceFileAtPath(absPath);
    return extractFileSymbols({ sourceFile, filePath });
  }
}
