import { basename } from "node:path";

import {
  UnsupportedFileError,
  type BackendRefreshCoverage,
  type FileSystem,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { FlowPragmaDetector } from "./flow-pragma-detector.js";

const FLOW_TYPED_FILE_KIND = "Flow-typed";

export class FlowTypedFiles {
  private flowTypedPaths = new Set<string>();

  constructor(
    private readonly fileSystem: FileSystem,
    private readonly checkedExtensions: readonly string[],
  ) {}

  async refresh(snapshot: WorkspaceSnapshot, coverage: BackendRefreshCoverage): Promise<void> {
    const flowTypedPaths =
      coverage === "workspace" ? new Set<string>() : new Set(this.flowTypedPaths);
    for (const file of snapshot.files) {
      if (await this.isFlowTyped(file)) {
        flowTypedPaths.add(file.relative);
      } else {
        flowTypedPaths.delete(file.relative);
      }
    }
    this.flowTypedPaths = flowTypedPaths;
  }

  refusal(relativePath: string): UnsupportedFileError | undefined {
    if (!this.flowTypedPaths.has(relativePath)) return undefined;
    return new UnsupportedFileError(relativePath, { fileKind: FLOW_TYPED_FILE_KIND });
  }

  private async isFlowTyped(file: WorkspaceFile): Promise<boolean> {
    const name = basename(file.relative);
    if (!this.checkedExtensions.some((extension) => name.endsWith(extension))) return false;
    return FlowPragmaDetector.hasFlowPragma(await this.fileSystem.readFile(file.absolute));
  }
}
