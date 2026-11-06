import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestDaemonController } from "../../test/helpers/daemon-controller.js";
import { TestDaemonRegistry } from "../../test/helpers/daemon-registry.js";
import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonLifecycleRequest,
  type DaemonLifecycleResponse,
} from "../transport/protocol.js";
import { NodeDaemonProcessTerminator } from "./process-launcher.js";
import { PosixDaemonProcessLifetime } from "./posix-process-lifetime.js";

class StartingStopHarness {
  public readonly root = mkdtempSync(join(tmpdir(), "symnav-starting-stop-"));
  public readonly identity = DaemonWorkspaceIdentity.from("/repo", this.root);
  public readonly registry = new TestDaemonRegistry(this.identity.registryDirectory);
  public readonly lifetime = PosixDaemonProcessLifetime.prepareChild(this.root);
  public readonly record: DaemonRecord = {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "test",
    workspaceRoot: this.identity.workspaceRoot,
    workspaceKey: this.identity.workspaceKey,
    stateKey: this.identity.stateKey,
    identityKey: this.identity.identityKey,
    instanceId: "starting-instance",
    processToken: "starting-token",
    endpoint: this.identity.endpoint("starting-instance"),
    pid: process.pid,
    processLifetime: this.lifetime.identity,
    state: "starting",
    startedAt: Date.now(),
    memoryCapBytes: 1024,
  };
  public readonly terminator = new NodeDaemonProcessTerminator(
    DaemonPolicy.currentSystem().values.shutdown,
  );
  public readonly numericTermination = vi.spyOn(this.terminator, "terminate").mockResolvedValue();
  public readonly requests: DaemonLifecycleRequest[] = [];
  public readonly controller = new TestDaemonController(this.registry, this, this.root, {
    processTerminator: this.terminator,
    stopTimeoutMs: 160,
    pollIntervalMs: 1,
  });
  public readonly terminated: Promise<void>;
  public finishOnTerminate = true;
  public finishOnKill = true;
  public unavailableUntil = 0;
  public authentication: "valid" | "wrong-instance" | "wrong-token" | "silent" = "valid";
  public onExit: (() => void) | undefined;
  private resolveTerminated!: () => void;

  public constructor() {
    this.terminated = new Promise((resolve) => {
      this.resolveTerminated = resolve;
    });
    expect(this.registry.acquireStartup(this.identity, this.record.instanceId)).toBeDefined();
    expect(this.registry.writeStartingIfStartupOwner(this.identity, this.record)).toBe(true);
  }

  public execute(): Promise<never> {
    return Promise.reject(new Error("Stop cannot execute navigation"));
  }

  public async request(
    _endpoint: string,
    request: DaemonLifecycleRequest,
  ): Promise<DaemonLifecycleResponse> {
    this.requests.push(request);
    if (Date.now() < this.unavailableUntil) throw new Error("Endpoint not yet listening");
    if (this.authentication === "silent") return new Promise(() => undefined);
    if (request.kind === "identify") {
      return {
        kind: "identity",
        instanceId: this.authentication === "wrong-instance" ? "successor" : this.record.instanceId,
        processToken:
          this.authentication === "wrong-token" ? "wrong-token" : this.record.processToken,
        pid: this.record.pid,
        startedAt: this.record.startedAt,
      };
    }
    if (request.kind === "terminate") {
      expect(request).toMatchObject({
        instanceId: this.record.instanceId,
        processToken: this.record.processToken,
      });
      this.resolveTerminated();
      if (this.finishOnTerminate) this.exit();
      return {
        kind: "terminating",
        instanceId: this.record.instanceId,
        processToken: this.record.processToken,
      };
    }
    if (request.kind === "kill") {
      expect(request).toMatchObject({
        instanceId: this.record.instanceId,
        processToken: this.record.processToken,
      });
      if (this.finishOnKill) this.exit();
      return {
        kind: "killing",
        instanceId: this.record.instanceId,
        processToken: this.record.processToken,
      };
    }
    throw new Error("Unexpected lifecycle request");
  }

  public exit(): void {
    this.lifetime.closeParentCopy();
    this.onExit?.();
  }

  public dispose(): void {
    this.lifetime.closeParentCopy();
    this.numericTermination.mockRestore();
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("authenticated starting stop", () => {
  const harnesses: StartingStopHarness[] = [];
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.dispose();
  });

  it("stops the authenticated foreign lifetime without signaling a matching local PID", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);

    await expect(harness.controller.stop("/repo")).resolves.toEqual({
      status: "stopped",
      workspaceRoot: "/repo",
      pid: process.pid,
    });

    expect(harness.requests.map((request) => request.kind)).toEqual(["identify", "terminate"]);
    expect(harness.numericTermination).not.toHaveBeenCalled();
    expect(harness.registry.startupOwner(harness.identity)).toBeUndefined();
    expect(harness.registry.read(harness.identity)).toBeUndefined();
    await expect(harness.controller.stop("/repo")).resolves.toMatchObject({
      status: "not-running",
    });
  });
  it("waits for delayed listening without waiting for readiness", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    harness.unavailableUntil = Date.now() + 25;
    await expect(harness.controller.stop("/repo")).resolves.toMatchObject({ status: "stopped" });
    expect(
      harness.requests.filter((request) => request.kind === "identify").length,
    ).toBeGreaterThan(1);
    expect(harness.numericTermination).not.toHaveBeenCalled();
  });

  it("retains ownership while authenticated termination has not ended the lifetime", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    harness.finishOnTerminate = false;
    const stopping = harness.controller.stop("/repo");
    await harness.terminated;
    expect(harness.registry.read(harness.identity)).toEqual(harness.record);
    expect(harness.registry.startupOwner(harness.identity)).toBeDefined();
    harness.exit();
    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
  });

  it.each(["wrong-instance", "wrong-token", "silent"] as const)(
    "retains live ownership when identity is %s",
    async (authentication) => {
      const harness = new StartingStopHarness();
      harnesses.push(harness);
      harness.authentication = authentication;
      const startedAt = Date.now();
      await expect(harness.controller.stop("/repo")).rejects.toThrow(
        /live but unresponsive|authenticated stop/,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
      expect(harness.requests.every((request) => request.kind === "identify")).toBe(true);
      expect(harness.numericTermination).not.toHaveBeenCalled();
      expect(harness.registry.read(harness.identity)).toEqual(harness.record);
      expect(harness.registry.startupOwner(harness.identity)).toBeDefined();
    },
  );

  it("does not remove successor ownership when the observed lifetime exits", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    const successor: DaemonRecord = {
      ...harness.record,
      processToken: "successor-token",
      startedAt: harness.record.startedAt + 1,
    };
    harness.onExit = () => {
      expect(harness.registry.writeStartingIfStartupOwner(harness.identity, successor)).toBe(true);
    };
    await expect(harness.controller.stop("/repo")).resolves.toMatchObject({ status: "stopped" });
    expect(harness.registry.read(harness.identity)).toEqual(successor);
    expect(harness.registry.startupOwner(harness.identity)).toMatchObject({
      processToken: successor.processToken,
    });
  });
  it("forces a non-draining starting daemon through authenticated kill", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    harness.finishOnTerminate = false;
    await expect(harness.controller.stop("/repo")).resolves.toMatchObject({ status: "killed" });
    expect(harness.requests.map((request) => request.kind)).toEqual([
      "identify",
      "terminate",
      "kill",
    ]);
    expect(harness.numericTermination).not.toHaveBeenCalled();
    expect(harness.registry.read(harness.identity)).toBeUndefined();
  });

  it("retains a live lifetime after kill acknowledgement and the stop deadline", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    harness.finishOnTerminate = false;
    harness.finishOnKill = false;
    await expect(harness.controller.stop("/repo")).rejects.toThrow(
      "did not exit after authenticated kill",
    );
    expect(harness.registry.read(harness.identity)).toEqual(harness.record);
    expect(harness.registry.startupOwner(harness.identity)).toBeDefined();
    expect(harness.numericTermination).not.toHaveBeenCalled();
  });

  it("retains live ownership when its mailbox disappears during drain", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    harness.finishOnTerminate = false;
    const stopping = harness.controller.stop("/repo");
    await harness.terminated;
    harness.unavailableUntil = Date.now() + 10_000;
    await expect(stopping).rejects.toThrow("did not exit after authenticated kill");
    expect(harness.registry.read(harness.identity)).toEqual(harness.record);
    expect(harness.numericTermination).not.toHaveBeenCalled();
  });

  it("does not treat missing lifetime evidence as successful shutdown", async () => {
    const harness = new StartingStopHarness();
    harnesses.push(harness);
    rmSync(harness.lifetime.identity.path);
    await expect(harness.controller.stop("/repo")).rejects.toThrow(
      "did not exit after authenticated kill",
    );
    expect(harness.registry.read(harness.identity)).toEqual(harness.record);
    expect(harness.numericTermination).not.toHaveBeenCalled();
  });
});
