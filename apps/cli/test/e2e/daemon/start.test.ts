import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";

describe("symnav daemon start", () => {
  const stateDirectories: string[] = [];
  const daemonPids: number[] = [];

  afterEach(async () => {
    await E2eProcessCleanup.terminate(daemonPids);
    daemonPids.length = 0;
    E2eProcessCleanup.removeDirectories(stateDirectories);
    stateDirectories.length = 0;
  });

  it.skipIf(process.platform === "win32")(
    "reports retained unverifiable legacy startup without launching another daemon",
    async () => {
      const stateDir = realpathSync(temporaryStateDirectory(stateDirectories));
      const cwd = canonicalWorkspaceRoot(realpathSync(temporaryWorkspace(stateDirectories)));
      const fixture = new BuiltLegacyStartupFixture(cwd, stateDir);
      try {
        await fixture.seeded;
        const before = new CliDaemonTesting(stateDir).inspector.listInstances();
        expect(before).toHaveLength(1);
        expect(before[0]?.pid).toBe(fixture.pid);
        const result = await fixture.start();
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Cannot start daemon:");
        expect(result.stderr).toContain("could not be verified; ownership was retained");
        expect(new CliDaemonTesting(stateDir).inspector.listInstances()).toEqual(before);
        expect(await fixture.unchanged()).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("starts, warms, and then reports the existing daemon", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const first = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    captureDaemonPid(stateDir, daemonPids);
    const second = runSymnavBinary(["daemon", "start"], {
      cwd,
      env: { SYMNAV_STATE_DIR: stateDir },
    });

    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toMatch(/^Daemon ready for .+\n\d+ files loaded in .+\n$/);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toMatch(/^Daemon already running for .+ \(pid \d+, up .+\)\n$/);
  });

  it("supports --cwd and stable JSON", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const cwd = temporaryWorkspace(stateDirectories);
    const result = runSymnavBinary(["--cwd", cwd, "daemon", "start", "--json"], {
      cwd: tmpdir(),
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    captureDaemonPid(stateDir, daemonPids);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      workspaceRoot: canonicalWorkspaceRoot(resolve(cwd)),
    });
  });

  it("preserves non-git errors and honors SYMNAV_DAEMON=0", () => {
    const stateDir = temporaryStateDirectory(stateDirectories);
    const workspace = temporaryWorkspace(stateDirectories);
    const nonGit = runSymnavBinary(["daemon", "start"], {
      cwd: stateDir,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const disabled = runSymnavBinary(["daemon", "start"], {
      cwd: workspace,
      env: { SYMNAV_STATE_DIR: stateDir, SYMNAV_DAEMON: "0" },
    });

    expect(nonGit.status).toBe(1);
    expect(nonGit.stderr).toContain("Cannot answer: not in a git workspace");
    expect(disabled.status).toBe(1);
    expect(disabled.stderr).toBe("Daemon disabled by SYMNAV_DAEMON=0\n");
  });
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-e2e-"));
  directories.push(directory);
  return directory;
}

function temporaryWorkspace(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-workspace-"));
  directories.push(directory);
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, "input.ts"), "export const value = 1;\n");
  return directory;
}

function captureDaemonPid(stateDir: string, pids: number[]): void {
  pids.push(...new CliDaemonTesting(stateDir).processIds());
}

class BuiltLegacyStartupFixture {
  public readonly seeded: Promise<unknown>;
  private readonly actor: ChildProcess;
  private readonly children: ChildProcess[] = [];

  public constructor(
    private readonly workspace: string,
    private readonly stateDirectory: string,
  ) {
    this.actor = spawn(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL(
            "../../../../../packages/daemon/test/actors/daemon-legacy-startup.ts",
            import.meta.url,
          ),
        ),
        workspace,
        stateDirectory,
        "pid-only",
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    this.children.push(this.actor);
    this.seeded = this.message("seeded");
  }

  public get pid(): number {
    return this.actor.pid!;
  }

  public async start(): Promise<RunSymnavBinaryResult> {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)), "daemon", "start"],
      {
        cwd: this.workspace,
        env: { ...process.env, SYMNAV_STATE_DIR: this.stateDirectory, SYMNAV_TELEMETRY: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        new Promise<RunSymnavBinaryResult>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (status) => resolve({ status, stdout, stderr }));
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Legacy explicit start remained pending")),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async unchanged(): Promise<boolean> {
    const verified = this.message("verified");
    this.actor.send("verify");
    return ((await verified) as { unchanged: boolean }).unchanged;
  }

  public async dispose(): Promise<void> {
    await E2eProcessCleanup.terminate([], this.children);
  }

  private message(kind: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Legacy fixture did not publish ${kind}`)),
        3_000,
      );
      this.actor.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.actor.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}
