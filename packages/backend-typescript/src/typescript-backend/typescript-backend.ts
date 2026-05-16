import { basename } from "node:path";

import type { FileSystem, FileSymbols, LanguageBackend, ResolvedPath } from "@symnav/core";
import { FileNotFoundError } from "@symnav/core";
import { Project } from "ts-morph";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

export class TypeScriptBackend implements LanguageBackend {
  static readonly extensions: readonly string[] = [".d.ts", ".ts", ".tsx", ".mts", ".cts"];

  static accepts(filePath: string): boolean {
    const name = basename(filePath);
    for (const ext of TypeScriptBackend.extensions) {
      if (name.endsWith(ext)) {
        return true;
      }
    }
    return false;
  }

  constructor(private readonly fs: FileSystem) {}

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async fileSymbols({ relative, absolute }: ResolvedPath): Promise<FileSymbols> {
    if (!this.fs.existsSync(absolute) || this.fs.isDirectorySync(absolute)) {
      throw new FileNotFoundError(relative);
    }
    const project = new Project({
      fileSystem: new WorkspaceFileSystemHost(this.fs),
    });
    const sourceFile = project.addSourceFileAtPath(absolute);
    return extractFileSymbols({ sourceFile, filePath: relative });
  }
}
