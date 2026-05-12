import { basename } from "node:path";

import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";
import { FileNotFoundError, OutsideWorkspaceError } from "@symnav/core";
import { Project, type SourceFile } from "ts-morph";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

const TYPESCRIPT_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".mts", ".cts"] as const;

export class TypeScriptBackend implements LanguageBackend {
  constructor(private readonly workspace: Workspace) {}

  accepts(filePath: string): boolean {
    const name = basename(filePath);
    for (const ext of TYPESCRIPT_EXTENSIONS) {
      if (name.endsWith(ext)) {
        return true;
      }
    }
    return false;
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
    const fs = this.workspace.fs;
    if (!fs.existsSync(absolutePath) || fs.isDirectorySync(absolutePath)) {
      throw new FileNotFoundError();
    }
    const project = new Project({
      fileSystem: new WorkspaceFileSystemHost(fs),
    });
    return project.addSourceFileAtPath(absolutePath);
  }
}
