import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import type { FileSystem } from "./file-system.js";

export class NodeFileSystem implements FileSystem {
  async readFile(absPath: string): Promise<string> {
    return readFile(absPath, "utf8");
  }

  async exists(absPath: string): Promise<boolean> {
    return existsSync(absPath);
  }

  async listDir(absPath: string): Promise<readonly string[]> {
    return readdir(absPath);
  }

  async isDirectory(absPath: string): Promise<boolean> {
    try {
      return (await stat(absPath)).isDirectory();
    } catch {
      return false;
    }
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
