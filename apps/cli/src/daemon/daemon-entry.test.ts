import { afterEach, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import type { ProgramDependencies } from "../program-dependencies.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonIdentityCoordinates } from "./daemon-protocol.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

interface DaemonProcessConfiguration extends DaemonIdentityCoordinates {
  readonly protocolVersion: number;
  readonly stateDirectory: string;
  readonly symnavVersion: string;
  readonly policy: ReturnType<DaemonPolicy["toSerialized"]>;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("../program.js");
  vi.doUnmock("./daemon-process-launcher.js");
  vi.doUnmock("./daemon-registry.js");
  vi.doUnmock("./local-daemon-transport.js");
  vi.doUnmock("./workspace-daemon.js");
  vi.doUnmock("./daemon-clock.js");
  vi.doUnmock("./daemon-logger.js");
  vi.doUnmock("./daemon-process-termination-observer.js");
});

it("keeps detached dependencies on the serialized canonical state directory", async () => {
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
  let dependencyStateDirectory = "";
  let daemonStateDirectory = "";
  let daemonWorkerLimit = 0;
  let daemonLogger: unknown;
  let terminationRecorder: unknown;
  let terminationObserverInstalled = false;
  const createDefaultDependencies = vi.fn(
    (stateDirectory?: string, _daemonPolicy?: DaemonPolicy) => {
      dependencyStateDirectory = stateDirectory ?? retargetedStateDirectory;
      return {
        stateDirectory: dependencyStateDirectory,
        symnavVersion: configuration.symnavVersion,
      } as unknown as ProgramDependencies;
    },
  );

  vi.doMock("../program.js", () => ({ createDefaultDependencies }));
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
  vi.doMock("./workspace-daemon.js", () => ({
    WorkspaceDaemon: class {
      constructor(options: {
        readonly dependencies: ProgramDependencies;
        readonly policy: DaemonPolicy;
        readonly logger: unknown;
      }) {
        const stateOwnedDependencies = options.dependencies as ProgramDependencies & {
          readonly stateDirectory: string;
        };
        daemonStateDirectory = stateOwnedDependencies.stateDirectory;
        daemonWorkerLimit = options.policy.values.resources.workerMaxOldGenerationSizeMiB;
        daemonLogger = options.logger;
      }

      async start(): Promise<void> {}
    },
  }));

  await import("./daemon-entry.js");

  expect(createDefaultDependencies).toHaveBeenCalledOnce();
  expect(createDefaultDependencies).toHaveBeenCalledWith(configuredStateDirectory, policy);
  expect(dependencyStateDirectory).toBe(configuredStateDirectory);
  expect(daemonStateDirectory).toBe(configuredStateDirectory);
  expect(daemonWorkerLimit).toBe(257);
  expect(terminationObserverInstalled).toBe(true);
  expect(terminationRecorder).toBe(daemonLogger);
});
