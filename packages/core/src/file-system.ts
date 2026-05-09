import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

export interface WorkspaceFileSystem {
  readFile(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  existsSync(absPath: string): boolean;
  readFileSync(absPath: string): string;
  listDirSync(absPath: string): readonly string[];
  isDirectorySync(absPath: string): boolean;
}

export class NodeFileSystem implements WorkspaceFileSystem {
  async readFile(absPath: string): Promise<string> {
    return readFile(absPath, "utf8");
  }

  async exists(absPath: string): Promise<boolean> {
    return existsSync(absPath);
  }

  existsSync(absPath: string): boolean {
    return existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    return readFileSync(absPath, "utf8");
  }

  listDirSync(absPath: string): readonly string[] {
    return readdirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    try {
      return statSync(absPath).isDirectory();
    } catch {
      return false;
    }
  }
}
