import { Project, ScriptTarget, type SourceFile } from "ts-morph";
import type { FileSystem } from "@symnav/core";
import { FileNotFoundError } from "@symnav/core";

import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

export function loadSourceFile(args: { fs: FileSystem; absolutePath: string }): SourceFile {
  if (!args.fs.existsSync(args.absolutePath) || args.fs.isDirectorySync(args.absolutePath)) {
    throw new FileNotFoundError();
  }
  const project = new Project({
    fileSystem: new WorkspaceFileSystemHost(args.fs),
    compilerOptions: { target: ScriptTarget.ES2022, allowJs: false },
  });
  return project.addSourceFileAtPath(args.absolutePath);
}
