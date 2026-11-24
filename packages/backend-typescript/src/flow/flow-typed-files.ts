import { basename } from "node:path";

import {
  UnsupportedFileError,
  type BackendRefreshCoverage,
  type FileSystem,
  type ResolvedPath,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { FlowPragmaDetector } from "./flow-pragma-detector.js";

const FLOW_TYPED_FILE_KIND = "Flow-typed";

interface FlowPragmaVerdict {
  readonly changeToken: string;
  readonly flowTyped: boolean;
}

export class FlowTypedFiles {
  private verdictsByRelativePath = new Map<string, FlowPragmaVerdict>();

  constructor(
    private readonly fileSystem: FileSystem,
    private readonly checkedExtensions: readonly string[],
  ) {}

  async refresh(
    snapshot: WorkspaceSnapshot,
    coverage: BackendRefreshCoverage,
  ): Promise<WorkspaceSnapshot> {
    const verdictsByRelativePath =
      coverage === "workspace"
        ? new Map<string, FlowPragmaVerdict>()
        : new Map(this.verdictsByRelativePath);
    for (const file of snapshot.files) {
      if (!this.checks(file)) continue;
      verdictsByRelativePath.set(file.relative, await this.verdictFor(file));
    }
    this.verdictsByRelativePath = verdictsByRelativePath;
    return { root: snapshot.root, files: this.answerable(snapshot.files) };
  }

  answerable<File extends ResolvedPath>(files: readonly File[]): readonly File[] {
    return files.filter((file) => !this.isFlowTyped(file.relative));
  }

  refusal(relativePath: string): UnsupportedFileError | undefined {
    if (!this.isFlowTyped(relativePath)) return undefined;
    return new UnsupportedFileError(relativePath, { fileKind: FLOW_TYPED_FILE_KIND });
  }

  private isFlowTyped(relativePath: string): boolean {
    return this.verdictsByRelativePath.get(relativePath)?.flowTyped ?? false;
  }

  private checks(file: WorkspaceFile): boolean {
    const name = basename(file.relative);
    return this.checkedExtensions.some((extension) => name.endsWith(extension));
  }

  private async verdictFor(file: WorkspaceFile): Promise<FlowPragmaVerdict> {
    const changeToken = file.metadata.changeToken;
    const previous = this.verdictsByRelativePath.get(file.relative);
    if (previous?.changeToken === changeToken) return previous;
    const text = await this.fileSystem.readFile(file.absolute);
    return { changeToken, flowTyped: FlowPragmaDetector.hasFlowPragma(text) };
  }
}
