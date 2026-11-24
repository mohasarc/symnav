import { basename } from "node:path";

import {
  UnsupportedFileError,
  type BackendRefreshCoverage,
  type FileSystem,
  type ResolvedPath,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";

import type { HiddenWorkspaceFiles } from "../typescript-backend/workspace-file-system-host.js";
import { WorkspacePathDialect } from "../typescript-backend/workspace-path-dialect.js";
import { FlowPragmaDetector } from "./flow-pragma-detector.js";

const FLOW_TYPED_FILE_KIND = "Flow-typed";

interface FlowPragmaVerdict {
  readonly absolute: string;
  readonly changeToken: string;
  readonly flowTyped: boolean;
}

export class FlowTypedFiles implements HiddenWorkspaceFiles {
  private verdictsByRelativePath = new Map<string, FlowPragmaVerdict>();
  private flowTypedPathKeys = new Set<string>();
  private pathDialect: WorkspacePathDialect | undefined;

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
    this.pathDialect = new WorkspacePathDialect(snapshot.root);
    this.flowTypedPathKeys = this.pathKeysOfFlowTyped(this.pathDialect);
    return { root: snapshot.root, files: this.answerable(snapshot.files) };
  }

  answerable<File extends ResolvedPath>(files: readonly File[]): readonly File[] {
    return files.filter((file) => !this.isFlowTyped(file.relative));
  }

  hides(absolutePath: string): boolean {
    if (this.pathDialect === undefined) return false;
    return this.flowTypedPathKeys.has(this.pathDialect.key(absolutePath));
  }

  refusal(relativePath: string): UnsupportedFileError | undefined {
    if (!this.isFlowTyped(relativePath)) return undefined;
    return new UnsupportedFileError(relativePath, { fileKind: FLOW_TYPED_FILE_KIND });
  }

  private isFlowTyped(relativePath: string): boolean {
    return this.verdictsByRelativePath.get(relativePath)?.flowTyped ?? false;
  }

  private pathKeysOfFlowTyped(pathDialect: WorkspacePathDialect): Set<string> {
    const flowTypedVerdicts = [...this.verdictsByRelativePath.values()].filter(
      (verdict) => verdict.flowTyped,
    );
    return new Set(flowTypedVerdicts.map((verdict) => pathDialect.key(verdict.absolute)));
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
    return {
      absolute: file.absolute,
      changeToken,
      flowTyped: FlowPragmaDetector.hasFlowPragma(text),
    };
  }
}
