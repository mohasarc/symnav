import { basename } from "node:path";

import type { FileSystem, FileSymbols, LanguageBackend, Workspace } from "@symnav/core";
import { FileNotFoundError, OutsideWorkspaceError } from "@symnav/core";
import { Project, type SourceFile } from "ts-morph";

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

  constructor(
    private readonly workspace: Workspace,
    private readonly fs: FileSystem,
  ) {}

  accepts(filePath: string): boolean {
    return TypeScriptBackend.accepts(filePath);
  }

  async fileSymbols(filePath: string): Promise<FileSymbols> {
    const absolutePath = this.workspace.toAbsolute(filePath);
    if (!this.workspace.isInWorkspace(absolutePath)) {
      throw new OutsideWorkspaceError();
    }
    const sourceFile = this.loadSourceFile(absolutePath);
    return extractFileSymbols({ sourceFile, filePath });
  }

  private loadSourceFile(absolutePath: string): SourceFile {
    if (!this.fs.existsSync(absolutePath) || this.fs.isDirectorySync(absolutePath)) {
      throw new FileNotFoundError();
    }
    const project = new Project({
      fileSystem: new WorkspaceFileSystemHost(this.fs),
    });
    return project.addSourceFileAtPath(absolutePath);
  }
}
