import { Project } from "ts-morph";
import {
  FileNotFoundError,
  type FileSymbols,
  type LanguageBackend,
  type Workspace,
} from "@symnav/core";
import { extractFileSymbols } from "./extract.js";
import { fileSystemHostFromWorkspace } from "./file-system-host.js";

export const TS_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".mts", ".cts"] as const;

export class TypeScriptBackend implements LanguageBackend {
  private readonly workspace: Workspace;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  accepts(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return TS_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  async fileSymbols(filePath: string): Promise<FileSymbols> {
    const absPath = this.workspace.toAbsolute(filePath);
    if (!(await this.workspace.fs.exists(absPath))) {
      throw new FileNotFoundError(filePath);
    }
    const project = new Project({
      useInMemoryFileSystem: false,
      fileSystem: fileSystemHostFromWorkspace(this.workspace.fs),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    const sourceFile = project.addSourceFileAtPath(absPath);
    return extractFileSymbols({ sourceFile, filePath });
  }
}
