import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { DAEMON_PROTOCOL_VERSION, type DaemonIdentityCoordinates } from "./daemon-protocol.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

interface DaemonProcessConfiguration extends DaemonIdentityCoordinates {
  readonly protocolVersion: number;
  readonly stateDirectory: string;
  readonly symnavVersion: string;
  readonly executorModuleUrl: string;
  readonly policy: ReturnType<DaemonPolicy["toSerialized"]>;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("./daemon-process-launcher.js");
  vi.doUnmock("./daemon-registry.js");
  vi.doUnmock("./local-daemon-transport.js");
  vi.doUnmock("./daemon-process-coordinator.js");
  vi.doUnmock("./daemon-clock.js");
  vi.doUnmock("./daemon-logger.js");
  vi.doUnmock("./daemon-process-termination-observer.js");
});

it("starts the detached daemon with only daemon-owned process configuration", async () => {
  const configuredStateDirectory = "/canonical/state-a";
  const retargetedStateDirectory = "/canonical/state-b";
  const identity = DaemonWorkspaceIdentity.from("/workspace", configuredStateDirectory);
  const policy = DaemonPolicyTestFactory.withOverrides(
    DaemonPolicy.fromSystemMemory({ totalBytes: 1024 * 1024 * 1024 }),
    {
      resources: {
        hardProcessRssBytes: 512 * 1024 * 1024,
        softProcessRssBytes: 409 * 1024 * 1024,
        resumeProcessRssBytes: 358 * 1024 * 1024,
        workerMaxOldGenerationSizeMiB: 257,
        workerHeapSampleIntervalMs: 26,
      },
    },
  );
  const configuration: DaemonProcessConfiguration = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    executorModuleUrl: "file:///absolute/daemon-executor.js",
    workspaceRoot: identity.workspaceRoot,
    stateDirectory: identity.stateDirectory,
    workspaceKey: identity.workspaceKey,
    stateKey: identity.stateKey,
    identityKey: identity.identityKey,
    instanceId: "instance",
    processToken: "token",
    endpoint: identity.endpoint("instance"),
    policy: policy.toSerialized(),
  };
  let daemonStateDirectory = "";
  let daemonExecutorModuleUrl = "";
  let daemonWorkerLimit = 0;
  let daemonLogger: unknown;
  let terminationRecorder: unknown;
  let terminationObserverInstalled = false;
  vi.doMock("./daemon-process-launcher.js", () => ({
    DaemonProcessConfigurationParser: { parse: () => configuration },
  }));
  vi.doMock("./daemon-registry.js", () => ({ DaemonRegistry: class {} }));
  vi.doMock("./local-daemon-transport.js", () => ({ LocalDaemonTransport: class {} }));
  vi.doMock("./daemon-clock.js", () => ({ NodeDaemonClock: class {} }));
  vi.doMock("./daemon-logger.js", () => ({ DaemonLogger: class {} }));
  vi.doMock("./daemon-process-termination-observer.js", () => ({
    DaemonProcessTerminationObserver: class {
      constructor(recorder: unknown) {
        terminationRecorder = recorder;
      }

      install(): void {
        terminationObserverInstalled = true;
      }
    },
  }));
  vi.doMock("./daemon-process-coordinator.js", () => ({
    DaemonProcessCoordinator: class {
      constructor(options: {
        readonly identity: { readonly stateDirectory: string };
        readonly executorModuleUrl: string;
        readonly policy: DaemonPolicy;
        readonly logger: unknown;
        readonly coordinates: DaemonIdentityCoordinates;
      }) {
        daemonStateDirectory = options.identity.stateDirectory;
        daemonExecutorModuleUrl = options.executorModuleUrl;
        daemonWorkerLimit = options.policy.values.resources.workerMaxOldGenerationSizeMiB;
        daemonLogger = options.logger;
        expect(options.coordinates).toEqual(expect.objectContaining(configuration));
      }

      async start(): Promise<void> {}
    },
  }));

  await import("./daemon-entry.js");

  expect(daemonStateDirectory).toBe(configuredStateDirectory);
  expect(daemonExecutorModuleUrl).toBe(configuration.executorModuleUrl);
  expect(daemonWorkerLimit).toBe(257);
  expect(terminationObserverInstalled).toBe(true);
  expect(terminationRecorder).toBe(daemonLogger);
});

it("keeps the process and worker entries independent from CLI and core modules", () => {
  for (const file of [
    "daemon-entry.ts",
    "daemon-navigation-worker-entry.ts",
    "daemon-navigation-worker-protocol.ts",
    "local-daemon-transport.ts",
    "daemon-process-coordinator.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toMatch(
      /@symnav\/core|\.\.\/(program|program-dependencies|command-execution-result)/,
    );
  }
});
