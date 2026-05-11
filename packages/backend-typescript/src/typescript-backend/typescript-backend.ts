import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";
import { FileNotFoundError } from "@symnav/core";
import { Project, ScriptTarget, type SourceFile } from "ts-morph";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { acceptsTypeScriptFile } from "./typescript-extensions.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

export class TypeScriptBackend implements LanguageBackend {
  constructor(private readonly workspace: Workspace) {}

  accepts(filePath: string): boolean {
    return acceptsTypeScriptFile(filePath);
  }

  async fileSymbols(filePath: string): Promise<FileSymbols> {
    const absolutePath = this.workspace.toAbsolute(filePath);
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
      compilerOptions: { target: ScriptTarget.ES2022, allowJs: false },
    });
    return project.addSourceFileAtPath(absolutePath);
  }
}
