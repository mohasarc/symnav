import { describe, expect, it } from "vitest";
import type { DaemonProcessTerminator } from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { DaemonRecordObserver } from "./daemon-record-observer.js";
import { DaemonTransportError, type LocalDaemonTransport } from "./local-daemon-transport.js";

describe("DaemonRecordObserver", () => {
  it("reports an unpublished starting record without probing its endpoint", async () => {
    const transport = new ObserverTransport([]);

    await expect(
      observer(transport, [101]).observe({ ...record("starting"), pid: 0 }),
    ).resolves.toMatchObject({
      kind: "starting",
      record: { instanceId: "instance" },
    });
    expect(transport.requests).toEqual([]);
  });

  it("probes a live starting daemon identity and activity concurrently", async () => {
    const transport = new ConcurrentObserverTransport();
    const observation = observer(transport, [101]).observe(record("starting"));

    await expect(transport.pingRequested).resolves.toBeUndefined();
    transport.allowIdentity();

    await expect(observation).resolves.toMatchObject({ kind: "responsive" });
  });

  it("keeps starting fallback when a live process has not published transport", async () => {
    const transport = new ObserverTransport([
      new Error("identity unavailable"),
      new Error("activity unavailable"),
    ]);

    await expect(observer(transport, [101]).observe(record("starting"))).resolves.toMatchObject({
      kind: "starting",
    });
    expect(transport.requests.map((request) => request.kind).sort()).toEqual(["identify", "ping"]);
  });

  it("reports an authenticated responsive daemon", async () => {
    const transport = new ObserverTransport([
      identityResponse(),
      {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        symnavVersion: "0.1.0",
        fileCount: 12,
      },
    ]);

    await expect(observer(transport, [101]).observe(record("ready"))).resolves.toMatchObject({
      kind: "responsive",
      pong: { fileCount: 12 },
    });
  });

  it("authenticates stop ownership without waiting for a status probe", async () => {
    const transport = new ObserverTransport([identityResponse()]);

    await expect(observer(transport, [101]).observeIdentity(record("ready"))).resolves.toEqual({
      kind: "authenticated",
      record: record("ready"),
    });
    expect(transport.requests.map((request) => request.kind)).toEqual(["identify"]);
  });

  it("retains a live silent daemon as unresponsive", async () => {
    const transport = new ObserverTransport([
      identityResponse(),
      new DaemonTransportError("timeout", "submitted-unconfirmed", "Daemon request timed out"),
    ]);

    await expect(observer(transport, [101]).observe(record("ready"))).resolves.toMatchObject({
      kind: "unresponsive",
      failureCode: "timeout",
    });
  });

  it.each([
    ["pid", { pid: 202, startedAt: 10 }],
    ["start timestamp", { pid: 101, startedAt: 20 }],
  ] as const)("rejects activity with mismatched %s identity", async (_label, coordinates) => {
    const transport = new ObserverTransport([
      identityResponse(),
      {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        symnavVersion: "0.1.0",
        activity: {
          lifecycle: "ready",
          ...coordinates,
          startupElapsedMs: 50,
          fileCount: 2,
          processRssBytes: 100,
          hardProcessRssBytes: 200,
          workerGeneration: 1,
          queued: 0,
          spoolBytes: 0,
        },
      },
    ]);

    await expect(observer(transport, [101]).observe(record("ready"))).resolves.toMatchObject({
      kind: "corrupt",
      record: { instanceId: "instance", pid: 101, startedAt: 10 },
    });
  });

  it("probes identity and status concurrently within one observation bound", async () => {
    const transport = new ConcurrentObserverTransport();
    const observation = observer(transport, [101]).observe(record("ready"));

    await expect(transport.pingRequested).resolves.toBeUndefined();
    transport.allowIdentity();

    await expect(observation).resolves.toMatchObject({ kind: "responsive" });
  });

  it("reports confirmed process exit without probing transport", async () => {
    const transport = new ObserverTransport([]);

    await expect(observer(transport, []).observe(record("ready"))).resolves.toMatchObject({
      kind: "exited",
    });
    expect(transport.requests).toEqual([]);
  });

  it.each(["incompatible", "corrupt"] as const)(
    "reports authenticated %s communication with exact identity evidence",
    async (failureCode) => {
      const transport = new ObserverTransport([
        identityResponse(),
        new DaemonTransportError(
          failureCode,
          "accepted",
          `Daemon communication is ${failureCode}`,
          "instance",
        ),
      ]);

      await expect(observer(transport, [101]).observe(record("ready"))).resolves.toEqual({
        kind: failureCode,
        record: record("ready"),
        evidence: {
          instanceId: "instance",
          processToken: "process-token",
          pid: 101,
          startedAt: 10,
        },
      });
    },
  );
});

class ObserverTransport {
  readonly requests: DaemonRequest[] = [];

  constructor(private readonly outcomes: readonly (DaemonResponse | Error)[]) {}

  async request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    this.requests.push(request);
    const outcome = this.outcomes[this.requests.length - 1];
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error("Unexpected observer request");
    return outcome;
  }
}

class ConcurrentObserverTransport extends ObserverTransport {
  readonly pingRequested: Promise<void>;
  private resolvePingRequested!: () => void;
  private readonly identityAllowed: Promise<void>;
  private resolveIdentityAllowed!: () => void;

  constructor() {
    super([]);
    this.pingRequested = new Promise((resolve) => {
      this.resolvePingRequested = resolve;
    });
    this.identityAllowed = new Promise((resolve) => {
      this.resolveIdentityAllowed = resolve;
    });
  }

  override async request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    if (request.kind === "identify") {
      await this.identityAllowed;
      return identityResponse();
    }
    if (request.kind === "ping") {
      this.resolvePingRequested();
      return {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        symnavVersion: "0.1.0",
      };
    }
    throw new Error("Unexpected observer request");
  }

  allowIdentity(): void {
    this.resolveIdentityAllowed();
  }
}

class ObserverTerminator implements DaemonProcessTerminator {
  readonly alive: ReadonlySet<number>;

  constructor(alive: readonly number[]) {
    this.alive = new Set(alive);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminate(): Promise<void> {}
}

function observer(transport: ObserverTransport, alive: readonly number[]): DaemonRecordObserver {
  return new DaemonRecordObserver(
    transport as unknown as LocalDaemonTransport,
    new ObserverTerminator(alive),
  );
}

function identityResponse(): DaemonResponse {
  return {
    kind: "identity",
    instanceId: "instance",
    processToken: "process-token",
    pid: 101,
    startedAt: 10,
  };
}

function record(state: DaemonRecord["state"]): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: "/repo",
    workspaceKey: "workspace-key",
    stateKey: "state-key",
    identityKey: "identity-key",
    instanceId: "instance",
    processToken: "process-token",
    endpoint: "/daemon.sock",
    pid: 101,
    state,
    startedAt: 10,
    memoryCapBytes: 1024,
  };
}
