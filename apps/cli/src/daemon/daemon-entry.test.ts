import { afterEach, expect, it, vi } from "vitest";
import type { ProgramDependencies } from "../program-dependencies.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonIdentityCoordinates } from "./daemon-protocol.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { DaemonResourcePolicyRecord } from "./daemon-resource-monitor.js";

interface DaemonProcessConfiguration extends DaemonIdentityCoordinates {
  readonly protocolVersion: number;
  readonly stateDirectory: string;
  readonly symnavVersion: string;
  readonly memoryCapBytes: number;
  readonly resourcePolicy: DaemonResourcePolicyRecord;
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
    memoryCapBytes: 1,
    resourcePolicy: {
      effectiveMemoryBytes: 1024 * 1024 * 1024,
      hardProcessRssBytes: 512 * 1024 * 1024,
      softProcessRssBytes: 409 * 1024 * 1024,
      resumeProcessRssBytes: 358 * 1024 * 1024,
      workerMaxOldGenerationSizeMb: 256,
    },
  };
  let dependencyStateDirectory = "";
  let daemonStateDirectory = "";
  let daemonWorkerLimit = 0;
  let daemonLogger: unknown;
  let terminationRecorder: unknown;
  let terminationObserverInstalled = false;
  const createDefaultDependencies = vi.fn((stateDirectory?: string) => {
    dependencyStateDirectory = stateDirectory ?? retargetedStateDirectory;
    return {
      stateDirectory: dependencyStateDirectory,
      symnavVersion: configuration.symnavVersion,
    } as unknown as ProgramDependencies;
  });

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
        readonly resourcePolicy: { readonly record: DaemonResourcePolicyRecord };
        readonly logger: unknown;
      }) {
        const stateOwnedDependencies = options.dependencies as ProgramDependencies & {
          readonly stateDirectory: string;
        };
        daemonStateDirectory = stateOwnedDependencies.stateDirectory;
        daemonWorkerLimit = options.resourcePolicy.record.workerMaxOldGenerationSizeMb;
        daemonLogger = options.logger;
      }

      async start(): Promise<void> {}
    },
  }));

  await import("./daemon-entry.js");

  expect(createDefaultDependencies).toHaveBeenCalledOnce();
  expect(createDefaultDependencies).toHaveBeenCalledWith(configuredStateDirectory);
  expect(dependencyStateDirectory).toBe(configuredStateDirectory);
  expect(daemonStateDirectory).toBe(configuredStateDirectory);
  expect(daemonWorkerLimit).toBe(256);
  expect(terminationObserverInstalled).toBe(true);
  expect(terminationRecorder).toBe(daemonLogger);
});
