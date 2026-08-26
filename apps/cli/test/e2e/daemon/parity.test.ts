import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalStateDir } from "@symnav/telemetry";
import type { ChildProcess } from "node:child_process";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../../src/daemon/daemon-protocol.js";
import { DaemonRegistry } from "../../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../../src/daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../../src/daemon/local-daemon-transport.js";
import { createDefaultDependencies } from "../../../src/program.js";
import { canonicalWorkspaceRoot } from "../../helpers/canonical-workspace-root.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { DaemonStateFiles } from "../../helpers/daemon-state-files.js";

describe("symnav daemon parity", () => {
  const harnesses: DaemonParityHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses) await harness.dispose();
    harnesses.length = 0;
  });

  it.each([
    ["text success", ["overview", "input.ts"]],
    ["json success", ["overview", "input.ts", "--json"]],
    ["resolve", ["resolve", "target"]],
    ["definition", ["def", "input.ts::target"]],
    ["references", ["refs", "input.ts::target", "--all"]],
    ["context", ["context", "input.ts::target"]],
    ["graph", ["graph", "input.ts::target"]],
    ["extraction warning", ["overview", "warning.ts"]],
    ["command usage error", ["def"]],
    ["user error", ["overview", "missing.ts"]],
    ["not found", ["resolve", "unknown"]],
    ["cwd-shaped target after separator", ["resolve", "--", "--cwd=target"]],
    ["help-shaped target after separator", ["resolve", "--", "--help"]],
    ["version-shaped target after separator", ["resolve", "--", "--version"]],
    ["help", ["--help"]],
    ["version", ["--version"]],
    ["stats", ["stats", "--json"]],
  ])("keeps %s bytes and status identical", (_name, args) => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);

    expect(harness.warm(args)).toEqual(harness.cold(args));
  });

  it("resolves relative --cwd from the requesting client directory", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.warm(["overview", "input.ts"]);
    const nestedDirectory = join(harness.workspaceRoot, "nested");
    mkdirSync(nestedDirectory);
    const args = ["--cwd", "..", "overview", "input.ts"];

    expect(harness.warmFrom(nestedDirectory, args)).toEqual(
      harness.coldFrom(nestedDirectory, args),
    );
  });

  it("uses the final repeated cwd from a client directory different from daemon launch", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const launcherDirectory = join(harness.workspaceRoot, "launcher");
    const clientDirectory = join(harness.workspaceRoot, "client");
    mkdirSync(launcherDirectory);
    mkdirSync(clientDirectory);
    harness.warmFrom(launcherDirectory, ["--cwd", "..", "overview", "input.ts"]);
    const daemonPid = harness.onlyDaemonPid();
    const args = ["--cwd=../ignored", "--cwd", "..", "overview", "input.ts"];

    expect(harness.warmFrom(clientDirectory, args)).toEqual(
      harness.coldFrom(clientDirectory, args),
    );
    expect(harness.onlyDaemonPid()).toBe(daemonPid);
  });
  it("elects one daemon when two commands start together", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const expected = harness.cold(["overview", "input.ts"]);

    const results = await Promise.all([
      harness.warmAsync(["overview", "input.ts"]),
      harness.warmAsync(["overview", "input.ts"]),
    ]);

    expect(results).toEqual([expected, expected]);
    expect(harness.onlyDaemonPid()).toBeGreaterThan(0);
  }, 15_000);
  it("does not replay or invalidate a live daemon after ambiguous response delivery", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const controlled = await harness.startControlledDaemon("--oversized-response");

    const failed = harness.warmWithTelemetry(["overview", "input.ts"]);

    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe("");
    expect(existsSync(`${controlled.requestStartedPath}.1`)).toBe(true);
    expect(harness.telemetryModes()).toEqual([]);
    expect(harness.daemonRecordCount()).toBe(1);
    expect(harness.onlyDaemonPid()).toBe(controlled.record.pid);
  }, 15_000);

  it("refreshes filesystem and ownership mutations before the next warm request", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.warm(["overview", "input.ts"]);
    const daemonPid = harness.onlyDaemonPid();
    const inputPath = join(harness.workspaceRoot, "input.ts");
    const originalTimes = statSync(inputPath);
    const originalSource = readFileSync(inputPath, "utf8");
    const equalSizeEdit =
      'export function edited(value: string): string { return value; }\nexport function caller(): string { return edited("x"); }\n';

    expect(Buffer.byteLength(equalSizeEdit)).toBe(Buffer.byteLength(originalSource));
    writeFileSync(inputPath, equalSizeEdit);
    utimesSync(inputPath, originalTimes.atime, originalTimes.mtime);
    const equalSizeWarmResult = harness.warm(["overview", "input.ts"]);
    expect(equalSizeWarmResult).toEqual(harness.cold(["overview", "input.ts"]));
    expect(equalSizeWarmResult.stdout).toContain("edited");

    writeFileSync(join(harness.workspaceRoot, "added.ts"), "export const added = 3;\n");
    expect(harness.warm(["overview", "added.ts"])).toEqual(harness.cold(["overview", "added.ts"]));

    unlinkSync(join(harness.workspaceRoot, "added.ts"));
    expect(harness.warm(["overview", "added.ts"])).toEqual(harness.cold(["overview", "added.ts"]));

    renameSync(join(harness.workspaceRoot, "input.ts"), join(harness.workspaceRoot, "renamed.ts"));
    expect(harness.warm(["overview", "renamed.ts"])).toEqual(
      harness.cold(["overview", "renamed.ts"]),
    );

    writeFileSync(join(harness.workspaceRoot, ".gitignore"), "renamed.ts\n");
    expect(harness.warm(["overview", "renamed.ts"])).toEqual(
      harness.cold(["overview", "renamed.ts"]),
    );
    writeFileSync(join(harness.workspaceRoot, ".gitignore"), "");
    expect(harness.warm(["overview", "renamed.ts"])).toEqual(
      harness.cold(["overview", "renamed.ts"]),
    );

    const nestedRoot = join(harness.workspaceRoot, "nested-owner");
    mkdirSync(nestedRoot);
    writeFileSync(join(nestedRoot, "source.ts"), "export const nested = true;\n");
    expect(harness.warm(["overview", "nested-owner/source.ts"])).toEqual(
      harness.cold(["overview", "nested-owner/source.ts"]),
    );
    mkdirSync(join(nestedRoot, ".git"));
    expect(harness.warm(["overview", "nested-owner/source.ts"])).toEqual(
      harness.cold(["overview", "nested-owner/source.ts"]),
    );
    rmSync(join(nestedRoot, ".git"), { recursive: true });
    expect(harness.warm(["overview", "nested-owner/source.ts"])).toEqual(
      harness.cold(["overview", "nested-owner/source.ts"]),
    );
    expect(harness.onlyDaemonPid()).toBe(daemonPid);
  });

  it("executes distinguishable queued requests FIFO and refreshes at queue-turn start", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const releasePath = join(harness.root, "release-first-request");
    const controlled = await harness.startControlledDaemon(releasePath);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10_000 });
    const first = transport.request(controlled.record.endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: controlled.record.instanceId,
      processToken: controlled.record.processToken,
      requestId: "fifo-first",
      request: {
        argv: ["--version"],
        cwd: harness.workspaceRoot,
        telemetryEnabled: false,
        executionMode: "warm",
      },
    });
    await waitUntil(() => existsSync(`${controlled.requestStartedPath}.1`));
    const second = harness.warmAsync(["overview", "input.ts"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(`${controlled.requestStartedPath}.2`)).toBe(false);
    writeFileSync(join(harness.workspaceRoot, "input.ts"), "export const queuedEdit = 3;\n");
    writeFileSync(releasePath, "release");

    const firstResponse = await first;
    const secondResult = await second;

    expect(firstResponse).toMatchObject({ kind: "result", result: { exitCode: 0 } });
    await waitUntil(() => existsSync(`${controlled.requestStartedPath}.2`));
    expect(secondResult).toEqual(harness.cold(["overview", "input.ts"]));
    if (firstResponse.kind !== "result") throw new Error("Expected first FIFO result");
    expect(decodeFrames(firstResponse.result.frames)).toMatch(/^\d+\.\d+\.\d+/);
    expect(secondResult.stdout).toContain("queuedEdit");
  }, 15_000);

  it("routes stats through and reuses the workspace daemon", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.warm(["overview", "input.ts"]);
    const daemonPid = harness.onlyDaemonPid();

    expect(harness.warm(["stats", "--json"])).toEqual(harness.cold(["stats", "--json"]));
    expect(harness.onlyDaemonPid()).toBe(daemonPid);
  });

  it("falls back after a confirmed crash while an independent replacement warms", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    expect(harness.daemonStart()).toMatchObject({ status: 0, stderr: "" });
    const first = harness.warmWithTelemetry(["overview", "input.ts"]);
    const firstPid = harness.onlyDaemonPid();
    process.kill(firstPid, "SIGKILL");
    await waitUntil(() => !processIsAlive(firstPid));

    expect(harness.warmWithTelemetry(["overview", "input.ts"])).toEqual(first);
    expect(harness.telemetryModes()).toEqual(["warm", "fallback"]);

    expect(harness.daemonStart()).toMatchObject({ status: 0, stderr: "" });
    expect(harness.warmWithTelemetry(["overview", "input.ts"])).toEqual(first);
    expect(harness.telemetryModes()).toEqual(["warm", "fallback", "warm"]);
    expect(harness.onlyDaemonPid()).not.toBe(firstPid);
  });

  it("recovers an orphaned startup mutation and keeps the next eligible command warm", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    await harness.orphanStartupMutation();

    expect(harness.daemonStatus()).toMatchObject({ status: 0, stderr: "" });
    expect(harness.daemonRecordCount()).toBe(0);
    expect(harness.warmWithTelemetry(["overview", "input.ts"])).toMatchObject({
      status: 0,
      stderr: "",
    });
    expect(harness.telemetryModes()).toEqual(["cold"]);
    expect(harness.daemonStart()).toMatchObject({ status: 0, stderr: "" });
    const daemonPid = harness.onlyDaemonPid();
    expect(harness.daemonRecordCount()).toBe(1);
    expect(harness.warmWithTelemetry(["overview", "input.ts"])).toMatchObject({
      status: 0,
      stderr: "",
    });
    expect(harness.onlyDaemonPid()).toBe(daemonPid);
    expect(harness.telemetryModes()).toEqual(["cold", "warm"]);
  }, 15_000);

  it("discards a disconnected daemon response and returns one complete cold answer", async () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const controlled = await harness.startControlledDaemon();
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10_000 });
    void transport
      .request(controlled.record.endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: controlled.record.instanceId,
        processToken: controlled.record.processToken,
        requestId: "crash-blocker",
        request: {
          argv: ["--version"],
          cwd: harness.workspaceRoot,
          telemetryEnabled: false,
          executionMode: "warm",
        },
      })
      .catch(() => undefined);
    await waitUntil(() => existsSync(controlled.requestStartedPath));
    const execution = harness.warmAsync(["overview", "input.ts"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(controlled.record.pid, "SIGKILL");

    expect(await execution).toEqual(harness.cold(["overview", "input.ts"]));
    expect(harness.warm(["overview", "input.ts"])).toEqual(harness.cold(["overview", "input.ts"]));
  }, 15_000);

  it("keeps cold bytes and status when daemon state path is an existing file", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    harness.replaceStateDirectoryWithFile();

    const fallback = harness.warm(["overview", "input.ts"]);

    expect(fallback).toEqual(harness.cold(["overview", "input.ts"]));
    expect(fallback).toMatchObject({ status: 0, stderr: "" });
    expect(harness.daemonRecordCount()).toBe(0);
  });

  it("keeps stats cold when workspace discovery fails", () => {
    const harness = new DaemonParityHarness();
    harnesses.push(harness);
    const outsideWorkspace = join(harness.root, "outside");
    mkdirSync(outsideWorkspace);

    expect(harness.warmFrom(outsideWorkspace, ["stats", "--json"])).toEqual(
      harness.coldFrom(outsideWorkspace, ["stats", "--json"]),
    );
    expect(harness.daemonRecordCount()).toBe(0);
  });

  it.each([
    ["resolve through path alias", ["resolve", "pathTarget"], "pathTarget"],
    ["resolve through workspace import", ["resolve", "workspaceTarget"], "workspaceTarget"],
    ["def through path alias", ["def", "packages/domain/src/index.ts::pathTarget"], "pathTarget"],
    [
      "def through workspace import",
      ["def", "packages/domain/src/index.ts::workspaceTarget"],
      "workspaceTarget",
    ],
    [
      "refs through path alias",
      ["refs", "packages/domain/src/index.ts::pathTarget", "--all"],
      "@domain/index",
    ],
    [
      "refs through workspace import",
      ["refs", "packages/domain/src/index.ts::workspaceTarget", "--all"],
      "@configured/domain",
    ],
    [
      "context through path alias",
      ["context", "packages/domain/src/index.ts::pathTarget"],
      "useConfiguredImports",
    ],
    [
      "context through workspace import",
      ["context", "packages/domain/src/index.ts::workspaceTarget"],
      "useConfiguredImports",
    ],
    [
      "depth-one graph through path alias",
      ["graph", "packages/app/src/index.ts::useConfiguredImports", "--depth", "1"],
      "pathTarget",
    ],
    [
      "depth-one graph through workspace import",
      ["graph", "packages/app/src/index.ts::useConfiguredImports", "--depth", "1"],
      "workspaceTarget",
    ],
    [
      "refs through a project-owned repeated alias",
      ["refs", "packages/domain/src/local.ts::domainLocalTarget", "--all"],
      "@local/local",
    ],
    [
      "depth-one graph through a project-owned repeated alias",
      ["graph", "packages/domain/src/index.ts::useDomainLocal", "--depth", "1"],
      "domainLocalTarget",
    ],
    [
      "refs through extended compiler options",
      ["refs", "packages/domain/src/inherited.ts::inheritedTarget", "--all"],
      "@inherited/inherited",
    ],
    [
      "depth-one graph through extended compiler options",
      ["graph", "packages/app/src/index.ts::useInheritedConfiguration", "--depth", "1"],
      "inheritedTarget",
    ],
    [
      "refs through a workspace subpath export",
      ["refs", "packages/domain/src/feature.ts::subpathTarget", "--all"],
      "@configured/domain/feature",
    ],
    [
      "context through a workspace subpath export",
      ["context", "packages/domain/src/feature.ts::subpathTarget"],
      "useWorkspaceSubpaths",
    ],
    [
      "depth-one graph through a workspace subpath export",
      ["graph", "packages/app/src/index.ts::useWorkspaceSubpaths", "--depth", "1"],
      "subpathTarget",
    ],
    [
      "refs through a patterned workspace subpath export",
      ["refs", "packages/domain/src/features/patterned.ts::patternedSubpathTarget", "--all"],
      "@configured/domain/features/patterned",
    ],
    [
      "refs through an inferred workspace import",
      ["refs", "packages/domain/src/index.ts::workspaceTarget", "--all"],
      "scratch/outside.ts",
    ],
    [
      "context through an inferred workspace import",
      ["context", "packages/domain/src/feature.ts::subpathTarget"],
      "useWorkspacePackagesFromInferred",
    ],
    [
      "depth-one graph through inferred workspace imports",
      ["graph", "scratch/outside.ts::useWorkspacePackagesFromInferred", "--depth", "1"],
      "patternedSubpathTarget",
    ],
  ])(
    "keeps configured project %s non-empty and byte-identical",
    (_name, args, expected) => {
      const harness = new DaemonParityHarness("configured-project-cases");
      harnesses.push(harness);

      const warm = harness.warm(args);

      expect(warm).toEqual(harness.cold(args));
      expect(warm).toMatchObject({ status: 0, stderr: "" });
      expect(warm.stdout).toContain(expected);
    },
    20_000,
  );

  it("keeps configured aliases out of cold and warm inferred semantics", () => {
    const harness = new DaemonParityHarness("configured-project-cases");
    harnesses.push(harness);
    const args = ["refs", "packages/app/src/local.ts::appLocalTarget", "--all"];

    const warm = harness.warm(args);

    expect(warm).toEqual(harness.cold(args));
    expect(warm).toMatchObject({ status: 0, stderr: "" });
    expect(warm.stdout).toContain("packages/app/src/index.ts");
    expect(warm.stdout).not.toContain("scratch/outside.ts");
  }, 20_000);

  it.each([
    ["malformed", "{ malformed"],
    ["missing", undefined],
  ])(
    "falls back without raw failures when root tsconfig is %s",
    (_name, config) => {
      const harness = new DaemonParityHarness("configured-project-cases");
      harnesses.push(harness);
      if (config === undefined) {
        harness.removeWorkspaceFile("tsconfig.json");
      } else {
        harness.writeWorkspaceFile("tsconfig.json", config);
      }
      const cases = [
        {
          args: ["refs", "packages/domain/src/index.ts::workspaceTarget", "--all"],
          expected: "scratch/outside.ts",
        },
        {
          args: ["context", "packages/domain/src/feature.ts::subpathTarget"],
          expected: "useWorkspacePackagesFromInferred",
        },
        {
          args: ["graph", "scratch/outside.ts::useWorkspacePackagesFromInferred", "--depth", "1"],
          expected: "patternedSubpathTarget",
        },
      ];

      for (const { args, expected } of cases) {
        const warm = harness.warm(args);
        expect(warm).toEqual(harness.cold(args));
        expect(warm).toMatchObject({ status: 0, stderr: "" });
        expect(warm.stdout).toContain(expected);
      }
    },
    40_000,
  );
});

class DaemonParityHarness {
  readonly root = mkdtempSync(join(tmpdir(), "symnav-daemon-parity-"));
  readonly workspaceRoot = join(this.root, "workspace");
  private readonly stateDirectory = join(this.root, "state");
  private readonly helperProcesses: ChildProcess[] = [];

  constructor(fixtureName?: string) {
    if (fixtureName) {
      cpSync(fixturePath(fixtureName), this.workspaceRoot, { recursive: true });
    }
    mkdirSync(join(this.workspaceRoot, ".git"), { recursive: true });
    if (!fixtureName) {
      writeFileSync(
        join(this.workspaceRoot, "input.ts"),
        'export function target(value: string): string { return value; }\nexport function caller(): string { return target("x"); }\n',
      );
      writeFileSync(
        join(this.workspaceRoot, "warning.ts"),
        'export function stillVisible(): string { return "ok"; }\n\n@orphaned\n',
      );
    }
  }

  writeWorkspaceFile(relativePath: string, content: string): void {
    writeFileSync(join(this.workspaceRoot, relativePath), content);
  }

  removeWorkspaceFile(relativePath: string): void {
    unlinkSync(join(this.workspaceRoot, relativePath));
  }

  warm(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1");
  }

  cold(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "0");
  }

  warmWithTelemetry(args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1", this.workspaceRoot, "1");
  }

  warmFrom(cwd: string, args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "1", cwd);
  }

  coldFrom(cwd: string, args: readonly string[]): RunSymnavBinaryResult {
    return this.run(args, "0", cwd);
  }

  warmAsync(args: readonly string[]): Promise<RunSymnavBinaryResult> {
    const cliBinPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "dist",
      "cli.js",
    );
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [cliBinPath, ...args], {
        cwd: this.workspaceRoot,
        env: this.environment("1"),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (status) => resolveResult({ status, stdout, stderr }));
    });
  }

  daemonStatus(): RunSymnavBinaryResult {
    return this.run(["daemon", "status"], "1");
  }

  daemonStart(): RunSymnavBinaryResult {
    return this.run(["daemon", "start"], "1");
  }

  async orphanStartupMutation(): Promise<void> {
    const controlledWorkspaceRoot = canonicalWorkspaceRoot(realpathSync(this.workspaceRoot));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("../../helpers/daemon-startup-mutation-owner.ts", import.meta.url)),
        controlledWorkspaceRoot,
        this.stateDirectory,
        "0",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    this.helperProcesses.push(child);
    const mutationOwnerPid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(new Error(`Mutation owner exited before readiness: code=${code} signal=${signal}`));
      });
      child.once("message", (message) => {
        if (typeof message !== "number" || !Number.isSafeInteger(message) || message <= 0) {
          reject(new Error(`Mutation owner published invalid pid: ${String(message)}`));
          return;
        }
        resolve(message);
      });
    });
    process.kill(mutationOwnerPid, "SIGKILL");
    child.kill("SIGKILL");
    await waitUntil(() => !processIsAlive(mutationOwnerPid));
  }

  async startControlledDaemon(releaseArgument = "--no-release"): Promise<ControlledDaemon> {
    const controlledWorkspaceRoot = canonicalWorkspaceRoot(realpathSync(this.workspaceRoot));
    const identity = DaemonWorkspaceIdentity.from(
      controlledWorkspaceRoot,
      canonicalStateDir(this.stateDirectory),
    );
    const registry = new DaemonRegistry(identity.registryDirectory);
    const instanceId = "controlled-crash";
    const processToken = `${instanceId}-token`;
    const readyPath = join(this.stateDirectory, `${instanceId}-ready`);
    const requestStartedPath = join(this.stateDirectory, `${instanceId}-request`);
    const symnavVersion = createDefaultDependencies(identity.stateDirectory).symnavVersion;
    const lease = registry.acquireStartup(identity, instanceId);
    if (lease === undefined) throw new Error("Expected controlled daemon startup ownership");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("../../helpers/workspace-daemon-stuck.ts", import.meta.url)),
        controlledWorkspaceRoot,
        this.stateDirectory,
        instanceId,
        processToken,
        readyPath,
        requestStartedPath,
        releaseArgument,
        symnavVersion,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          SYMNAV_STATE_DIR: this.stateDirectory,
          SYMNAV_TELEMETRY: "1",
        },
      },
    );
    this.helperProcesses.push(child);
    await waitUntil(() => existsSync(`${readyPath}.boot`));
    const daemonPid = Number(readFileSync(`${readyPath}.boot`, "utf8"));
    const record: DaemonRecord = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion,
      workspaceRoot: controlledWorkspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      pid: daemonPid,
      state: "starting",
      startedAt: Date.now(),
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
    };
    if (!registry.writeStartingIfStartupOwner(identity, record)) {
      throw new Error("Controlled daemon lost startup ownership");
    }
    await waitUntil(() => existsSync(readyPath));
    lease.release();
    const readyRecord = registry.read(identity);
    if (readyRecord?.state !== "ready") throw new Error("Controlled daemon did not become ready");
    return { child, requestStartedPath, record: readyRecord };
  }

  onlyDaemonPid(): number {
    const records = DaemonStateFiles.matchingPaths(this.stateDirectory, ".json");
    expect(records).toHaveLength(1);
    const record = JSON.parse(readFileSync(records[0]!, "utf8")) as {
      pid: number;
    };
    return record.pid;
  }

  daemonRecordCount(): number {
    return DaemonStateFiles.matchingPaths(this.stateDirectory, ".json").length;
  }

  replaceStateDirectoryWithFile(): void {
    writeFileSync(this.stateDirectory, "invalid daemon state path");
  }

  telemetryModes(): readonly string[] {
    const usagePath = join(this.stateDirectory, "usage.jsonl");
    if (!existsSync(usagePath)) return [];
    return readFileSync(usagePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { executionMode: string }).executionMode);
  }

  async dispose(): Promise<void> {
    await E2eProcessCleanup.terminateAndRemoveDirectories(
      [this.root],
      () => this.daemonProcessIds(),
      { children: this.helperProcesses },
    );
    this.helperProcesses.length = 0;
  }

  private daemonProcessIds(): readonly number[] {
    return DaemonStateFiles.matchingPaths(this.stateDirectory, ".json").map((path) => {
      const record = JSON.parse(readFileSync(path, "utf8")) as { readonly pid: number };
      return record.pid;
    });
  }

  private run(
    args: readonly string[],
    daemon: string,
    cwd = this.workspaceRoot,
    telemetry = "0",
  ): RunSymnavBinaryResult {
    return runSymnavBinary(args, {
      cwd,
      env: this.environment(daemon, telemetry),
    });
  }

  private environment(daemon: string, telemetry = "0"): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SYMNAV_DAEMON: daemon,
      SYMNAV_STATE_DIR: this.stateDirectory,
      SYMNAV_TELEMETRY: telemetry,
    };
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function decodeFrames(frames: readonly { readonly bytesBase64: string }[]): string {
  return frames.map((frame) => Buffer.from(frame.bytesBase64, "base64").toString()).join("");
}

interface ControlledDaemon {
  readonly child: ChildProcess;
  readonly record: DaemonRecord;
  readonly requestStartedPath: string;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for controlled daemon state");
}
