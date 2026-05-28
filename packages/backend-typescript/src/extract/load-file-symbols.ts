import type { FileSystem, OverviewFileSymbols, ResolvedPath } from "@symnav/core";
import { Project } from "ts-morph";

import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";
import { extractFileSymbols } from "./extract-file-symbols.js";

export function loadFileSymbols(fs: FileSystem, file: ResolvedPath): OverviewFileSymbols {
  const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  const sourceFile = project.addSourceFileAtPath(file.absolute);
  return extractFileSymbols({ sourceFile, filePath: file.relative });
}
