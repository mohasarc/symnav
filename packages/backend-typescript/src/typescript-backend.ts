import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";

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
 * Stage 1 runs ts-morph in single-file mode: no `tsconfig.json` is loaded,
 * cross-file resolution is out of scope. Phase 5 only delivers `accepts`; the
 * `fileSymbols` implementation arrives with the next commits.
 */
export class TypeScriptBackend implements LanguageBackend {
  // The workspace is captured for use by `fileSymbols`; the field is unused
  // until that method is implemented in the next commit.
  constructor(private readonly workspace: Workspace) {}

  accepts(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return TS_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  fileSymbols(_filePath: string): Promise<FileSymbols> {
    throw new Error("TypeScriptBackend.fileSymbols is not implemented yet");
  }
}
