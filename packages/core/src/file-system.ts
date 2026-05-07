import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export interface WorkspaceFileSystem {
  readFile(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  existsSync(absPath: string): boolean;
  readFileSync(absPath: string): string;
  listDirSync(absPath: string): readonly string[];
  isDirectorySync(absPath: string): boolean;
}

export function nodeFileSystem(): WorkspaceFileSystem {
  return {
    async readFile(absPath) {
      return await readFile(absPath, "utf8");
    },
    async exists(absPath) {
      try {
        await stat(absPath);
        return true;
      } catch {
        return false;
      }
    },
    existsSync(absPath) {
      return existsSync(absPath);
    },
    readFileSync(absPath) {
      return readFileSync(absPath, "utf8");
    },
    listDirSync(absPath) {
      return readdirSync(absPath);
    },
    isDirectorySync(absPath) {
      try {
        return statSync(absPath).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
