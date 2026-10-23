import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeDaemonProcessLauncher } from "../process/process-launcher.js";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import { DaemonRegistry, type StartupOwner } from "../registry/registry.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { FileDaemonConnectionClient } from "../transport/file-connection-client.js";
import type { FileDaemonOwner } from "../transport/file-owner.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../transport/protocol.js";
import { DaemonClientRuntime } from "./daemon-client-runtime.js";

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "explicit startup required-write observation",
  () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(["ready", "legacy"] as const)(
      "reports the first real %s channel mkdir denial once while retaining ownership",
      async (mode) => {
        const fixture = await StartWriteFixture.create(mode);
        await chmod(fixture.directory, 0o500);
        const stateWriteFailed = vi.fn();
        try {
          await expect(fixture.start(stateWriteFailed)).rejects.toThrow(fixture.failureMessage);
          expect(fixture.transportFailures.length).toBeGreaterThan(0);
          expect(fixture.transportFailures[0]).toMatchObject({
            code: "EACCES",
            syscall: "mkdir",
          });
          expect(stateWriteFailed).toHaveBeenCalledOnce();
          expect(stateWriteFailed).toHaveBeenCalledWith({
            path: fixture.transportFailures[0]!.path,
            osCode: "EACCES",
          });
          expect(fixture.transportFailures[0]!.path).toContain(fixture.directory);
          expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(fixture.owner);
          expect(fixture.launch).not.toHaveBeenCalled();
          expect(fixture.executorFactory).not.toHaveBeenCalled();
        } finally {
          await fixture.dispose();
        }
      },
    );

    it.each(["ready", "legacy"] as const)(
      "does not report a %s ownership read denial as a state write",
      async (mode) => {
        const fixture = await StartWriteFixture.create(mode);
        await chmod(fixture.ownerPath, 0o000);
        const stateWriteFailed = vi.fn();
        try {
          await expect(fixture.start(stateWriteFailed)).rejects.toThrow(fixture.failureMessage);
          expect(fixture.transportFailures.length).toBeGreaterThan(0);
          expect(fixture.transportFailures[0]).toMatchObject({
            path: fixture.ownerPath,
            code: "EACCES",
            syscall: "open",
          });
          expect(stateWriteFailed).not.toHaveBeenCalled();
          expect(fixture.launch).not.toHaveBeenCalled();
          expect(fixture.executorFactory).not.toHaveBeenCalled();
        } finally {
          await fixture.dispose();
        }
      },
    );

    it("isolates callbacks across repeated and overlapping starts on the same client", async () => {
      const fixture = await StartWriteFixture.create("ready");
      await chmod(fixture.directory, 0o500);
      const firstFailure = vi.fn();
      const secondFailure = vi.fn();
      const thirdFailure = vi.fn();
      try {
        await expect(fixture.start(firstFailure)).rejects.toThrow(fixture.failureMessage);
        const outcomes = await Promise.allSettled([
          fixture.start(secondFailure),
          fixture.start(),
          fixture.start(thirdFailure),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual([
          "rejected",
          "rejected",
          "rejected",
        ]);
        for (const observer of [firstFailure, secondFailure, thirdFailure]) {
          expect(observer).toHaveBeenCalledOnce();
          expect(fixture.transportFailures).toContainEqual(
            expect.objectContaining({ path: observer.mock.calls[0]![0].path, code: "EACCES" }),
          );
        }
        expect(
          new Set(
            [firstFailure, secondFailure, thirdFailure].map(
              (observer) => observer.mock.calls[0]![0].path,
            ),
          ).size,
        ).toBe(3);
        expect(fixture.launch).not.toHaveBeenCalled();
        expect(fixture.executorFactory).not.toHaveBeenCalled();
      } finally {
        await fixture.dispose();
      }
    });
  },
);

class StartWriteFixture {
  public readonly transportFailures: NodeJS.ErrnoException[] = [];
  public readonly launch = vi
    .spyOn(NodeDaemonProcessLauncher.prototype, "launch")
    .mockRejectedValue(new Error("Unexpected daemon launch"));
  public readonly executorFactory = vi.fn(() => {
    throw new Error("Unexpected local execution");
  });
  public readonly client: DaemonClientRuntime;

  private constructor(
    public readonly state: string,
    public readonly directory: string,
    public readonly owner: FileDaemonOwner,
    private readonly record: DaemonRecord,
  ) {
    this.client = new DaemonClientRuntime({
      stateDirectory: state,
      productVersion: "0.1.0",
      daemonEnabled: true,
      executorFactory: this.executorFactory,
      executorModuleUrl: "file:///unused-executor.js",
      readinessProbe: { commandName: "version", argv: ["--version"] },
    });
    const connect = FileDaemonConnectionClient.prototype.connect;
    const failures = this.transportFailures;
    vi.spyOn(FileDaemonConnectionClient.prototype, "connect").mockImplementation(async function (
      this: FileDaemonConnectionClient,
      ...arguments_: Parameters<typeof connect>
    ) {
      try {
        return await connect.apply(this, arguments_);
      } catch (error) {
        failures.push(error as NodeJS.ErrnoException);
        throw error;
      }
    });
  }

  public get ownerPath(): string {
    return join(this.directory, "owner.json");
  }

  public get failureMessage(): string {
    return this.record.state === "ready"
      ? `Daemon process ${process.pid} is live but unresponsive; ownership was retained`
      : `Daemon startup ownership for process ${process.pid} could not be verified; ownership was retained`;
  }

  public static async create(mode: "ready" | "legacy"): Promise<StartWriteFixture> {
    const state = await mkdtemp(join(tmpdir(), "symnav-start-observation-"));
    const identity = DaemonWorkspaceIdentity.from(join(state, "workspace"), state);
    const lifetime = PosixDaemonProcessLifetime.current(state);
    const endpoint = join(state, "endpoint");
    const token = randomUUID();
    const directory = join(endpoint, token);
    const owner: FileDaemonOwner = { pid: process.pid, token, processLifetime: lifetime };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "owner.json"), JSON.stringify(owner));
    const record: DaemonRecord = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "0.1.0",
      workspaceRoot: identity.workspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId: "instance",
      processToken: "process",
      endpoint,
      pid: process.pid,
      state: mode === "ready" ? "ready" : "starting",
      startedAt: 1,
      memoryCapBytes: 1024,
      ...(mode === "ready" ? { processLifetime: lifetime } : {}),
    };
    const startupOwner: StartupOwner = {
      identityKey: identity.identityKey,
      instanceId: record.instanceId,
      processToken: record.processToken,
      ownerPid: process.pid,
      ownerKind: "daemon",
      acquiredAt: 1,
      heartbeatAt: 1,
      revision: "revision",
    };
    vi.spyOn(DaemonRegistry.prototype, "read").mockReturnValue(record);
    vi.spyOn(DaemonRegistry.prototype, "readStored").mockReturnValue(record);
    vi.spyOn(DaemonRegistry.prototype, "readStoredInstance").mockReturnValue(record);
    vi.spyOn(DaemonRegistry.prototype, "startupOwner").mockReturnValue(startupOwner);
    vi.spyOn(DaemonRegistry.prototype, "acquireStartup").mockReturnValue(undefined);
    return new StartWriteFixture(state, directory, owner, record);
  }

  public start(stateWriteFailed?: (failure: { path: string; osCode?: string }) => void) {
    return this.client.control({
      action: "start",
      workspaceRoot: this.record.workspaceRoot,
      ...(stateWriteFailed === undefined ? {} : { stateWriteFailed }),
    });
  }

  public async dispose(): Promise<void> {
    await chmod(this.directory, 0o700);
    await chmod(this.ownerPath, 0o600);
    await rm(this.state, { recursive: true, force: true });
  }
}
