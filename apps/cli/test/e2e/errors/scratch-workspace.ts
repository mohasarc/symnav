import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixturePath, runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";
import type { PathPlaceholder } from "./error-output.js";

export interface ScratchRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const UNREADABLE_DIRECTORY_MODE = 0o000;
const READABLE_DIRECTORY_MODE = 0o755;

export class ScratchWorkspace {
  private static readonly created: ScratchWorkspace[] = [];
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-errors-")));
  readonly workspaceRoot = join(this.root, "workspace");
  readonly stateDirectory = join(this.root, "state");
  private readonly unreadableDirectories: string[] = [];

  constructor(fixtureName: string) {
    cpSync(fixturePath(fixtureName), this.workspaceRoot, { recursive: true });
    ensureFixtureGitMarker(this.workspaceRoot);
    ScratchWorkspace.created.push(this);
  }

  static disposeAll(): void {
    for (const scratch of ScratchWorkspace.created.splice(0)) scratch.dispose();
  }

  markNestedWorkspace(relativePath: string): void {
    ensureFixtureGitMarker(join(this.workspaceRoot, relativePath));
  }

  writeFile(relativePath: string, content: string): void {
    const path = join(this.workspaceRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  makeUnreadableDirectory(relativePath: string): void {
    const path = join(this.workspaceRoot, relativePath);
    mkdirSync(path, { recursive: true });
    chmodSync(path, UNREADABLE_DIRECTORY_MODE);
    this.unreadableDirectories.push(path);
  }

  run(args: readonly string[], options: ScratchRunOptions = {}): RunSymnavBinaryResult {
    return runSymnavBinary(args, {
      cwd: options.cwd ?? this.workspaceRoot,
      env: { SYMNAV_STATE_DIR: this.stateDirectory, ...options.env },
    });
  }

  placeholders(): readonly PathPlaceholder[] {
    return [
      { path: this.workspaceRoot, placeholder: "<workspace>" },
      { path: this.root, placeholder: "<scratch>" },
    ];
  }

  private dispose(): void {
    for (const path of this.unreadableDirectories.splice(0)) {
      chmodSync(path, READABLE_DIRECTORY_MODE);
    }
    E2eProcessCleanup.removeDirectories([this.root]);
  }
}
