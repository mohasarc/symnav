import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import { NodeDaemonProcessTerminator } from "../process/process-launcher.js";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonLifecycleRequest,
  type DaemonLifecycleResponse,
  type DaemonRecord,
} from "../transport/protocol.js";
import { DaemonRecordObserver } from "./record-observer.js";

class NamespaceObservationFixture {
  public readonly state = mkdtempSync(join(tmpdir(), "symnav-observe-"));
  public readonly lifetime = PosixDaemonProcessLifetime.prepareChild(this.state);
  public readonly record: DaemonRecord = {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "test",
    workspaceRoot: "/repo",
    workspaceKey: "workspace",
    stateKey: "state",
    identityKey: "identity",
    instanceId: "instance",
    processToken: "secret",
    endpoint: join(this.state, "endpoint"),
    pid: 2147483647,
    state: "ready",
    startedAt: 1,
    memoryCapBytes: 100,
    processLifetime: this.lifetime.identity,
  };
  public readonly transport = {
    request: async (
      _endpoint: string,
      request: DaemonLifecycleRequest,
    ): Promise<DaemonLifecycleResponse> =>
      request.kind === "identify"
        ? {
            kind: "identity",
            instanceId: "instance",
            processToken: "secret",
            pid: this.record.pid,
            startedAt: 1,
          }
        : {
            kind: "pong",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            instanceId: "instance",
            symnavVersion: "test",
            fileCount: 1,
          },
  };
  public readonly observer = new DaemonRecordObserver(
    this.transport,
    new NodeDaemonProcessTerminator(DaemonPolicy.currentSystem().values.shutdown),
  );
  public dispose(): void {
    this.lifetime.closeParentCopy();
    rmSync(this.state, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("namespace-safe record observation", () => {
  const fixtures: NamespaceObservationFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.dispose();
  });
  it("authenticates a live daemon whose numeric PID is absent", async () => {
    const fixture = new NamespaceObservationFixture();
    fixtures.push(fixture);
    await expect(fixture.observer.observe(fixture.record)).resolves.toMatchObject({
      kind: "responsive",
    });
    await expect(fixture.observer.observeIdentity(fixture.record)).resolves.toMatchObject({
      kind: "authenticated",
    });
  });
  it("retains unknown legacy ownership and timed-out live readers", async () => {
    const fixture = new NamespaceObservationFixture();
    fixtures.push(fixture);
    fixture.transport.request = async () => {
      throw new Error("timeout");
    };
    await expect(fixture.observer.observe(fixture.record)).resolves.toMatchObject({
      kind: "unresponsive",
    });
    const { processLifetime: _lifetime, ...legacy } = fixture.record;
    await expect(fixture.observer.observe(legacy)).resolves.toMatchObject({ kind: "unresponsive" });
  });
  it("proves death despite an unrelated matching local PID", async () => {
    const fixture = new NamespaceObservationFixture();
    fixtures.push(fixture);
    fixture.lifetime.closeParentCopy();
    await expect(
      fixture.observer.observe({ ...fixture.record, pid: process.pid }),
    ).resolves.toMatchObject({ kind: "exited" });
  });
});
