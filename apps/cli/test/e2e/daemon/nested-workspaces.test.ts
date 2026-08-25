import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";
import { symbolCommands } from "../symbol-command.js";

describe("nested Git workspaces", () => {
  const harnesses: NestedWorkspaceHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses) await harness.dispose();
    harnesses.length = 0;
  });

  it("keeps parent rejection identical in cold and warm modes while nested --cwd succeeds", () => {
    const harness = new NestedWorkspaceHarness();
    harnesses.push(harness);
    expect(harness.startParentDaemon()).toMatchObject({ status: 0, stderr: "" });

    const nestedPath = "nested/src/nested.ts";
    const expectedError =
      `Cannot answer: ${nestedPath} belongs to nested Git workspace rooted at ${harness.nestedRoot}, ` +
      `not selected workspace ${harness.workspaceRoot}; run from ${harness.nestedRoot} or use --cwd ${harness.nestedRoot}.\n`;
    const parentCommands: readonly (readonly string[])[] = [
      ["overview", nestedPath],
      ...symbolCommands.map((command) => [command, `${nestedPath}::nestedTarget`] as const),
    ];

    for (const args of parentCommands) {
      const cold = harness.cold(args);
      expect(harness.warm(args)).toEqual(cold);
      expect(cold).toEqual({ status: 1, stdout: "", stderr: expectedError });
    }

    const nestedOverviewArgs = ["--cwd", harness.nestedRoot, "overview", "src/nested.ts"];
    const coldNestedOverview = harness.cold(nestedOverviewArgs);
    expect(harness.warm(nestedOverviewArgs)).toEqual(coldNestedOverview);
    expect(coldNestedOverview).toMatchObject({ status: 0, stderr: "" });
    expect(coldNestedOverview.stdout).toContain("nestedTarget");
  }, 15_000);
});

class NestedWorkspaceHarness {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-nested-workspace-")));
  readonly workspaceRoot = join(this.root, "workspace");
  readonly nestedRoot = join(this.workspaceRoot, "nested");
  private readonly stateDirectory = join(this.root, "state");

  constructor() {
    cpSync(fixturePath("nested-workspace-cases"), this.workspaceRoot, { recursive: true });
    ensureFixtureGitMarker(this.workspaceRoot);
    ensureFixtureGitMarker(this.nestedRoot);
  }

  startParentDaemon(): RunSymnavBinaryResult {
    return this.run(["daemon", "start"], "1");
  }

  cold(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "0");
  }

  warm(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1");
  }

  async dispose(): Promise<void> {
    await E2eProcessCleanup.terminate(this.daemonProcessIds());
    E2eProcessCleanup.removeDirectories([this.root]);
  }

  private run(args: readonly string[], daemonMode: string): RunSymnavBinaryResult {
    return runSymnavBinary(args, {
      cwd: this.workspaceRoot,
      env: {
        SYMNAV_DAEMON: daemonMode,
        SYMNAV_STATE_DIR: this.stateDirectory,
        SYMNAV_TELEMETRY: "0",
      },
    });
  }

  private daemonProcessIds(): readonly number[] {
    const recordsDirectory = join(this.stateDirectory, "daemons");
    if (!existsSync(recordsDirectory)) return [];
    return readdirSync(recordsDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const record = JSON.parse(readFileSync(join(recordsDirectory, name), "utf8")) as {
          readonly pid: number;
        };
        return record.pid;
      });
  }
}
