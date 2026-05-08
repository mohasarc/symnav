import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * Filesystem port used by `Workspace`. Production code uses `nodeFileSystem()`;
 * tests inject an in-memory implementation via `@symnav/testing`'s
 * `inMemoryFileSystem`. Synchronous methods are used during workspace
 * construction (root walk, `.gitignore` aggregation); async methods are used
 * for general file reads thereafter.
 */
export interface WorkspaceFileSystem {
  readFile(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  /** Synchronous existence check; used during workspace construction (root walk). */
  existsSync(absPath: string): boolean;
  /** Synchronous read; used during workspace construction (.gitignore aggregation). */
  readFileSync(absPath: string): string;
  /** Synchronous directory listing for .gitignore discovery. */
  listDirSync(absPath: string): readonly string[];
  /** Whether the path is a directory. */
  isDirectorySync(absPath: string): boolean;
}

export function nodeFileSystem(): WorkspaceFileSystem {
  return {
    async readFile(absPath: string): Promise<string> {
      return readFile(absPath, "utf8");
    },
    async exists(absPath: string): Promise<boolean> {
      return existsSync(absPath);
    },
    existsSync(absPath: string): boolean {
      return existsSync(absPath);
    },
    readFileSync(absPath: string): string {
      return readFileSync(absPath, "utf8");
    },
    listDirSync(absPath: string): readonly string[] {
      return readdirSync(absPath);
    },
    isDirectorySync(absPath: string): boolean {
      try {
        return statSync(absPath).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
