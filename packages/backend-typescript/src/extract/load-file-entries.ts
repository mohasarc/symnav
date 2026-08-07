import type { DiagnosticSink, FileSystem, OverviewFileEntries, ResolvedPath } from "@symnav/core";
import { Project } from "ts-morph";

import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";
import { extractFileEntries } from "./extract-file-entries.js";

export function loadFileEntries(
  fs: FileSystem,
  file: ResolvedPath,
  diagnostics?: DiagnosticSink,
): OverviewFileEntries {
  const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  const sourceFile = project.addSourceFileAtPath(file.absolute);
  return extractFileEntries({ sourceFile, filePath: file.relative, diagnostics });
}
