import { InMemoryFileSystem } from "@symnav/core";
import type { GitHistory, HistoryEntry } from "@symnav/core";
import { DaemonPolicy, type DaemonClient } from "@symnav/daemon";
import type { Clock, Recorder, UsageEventInput } from "@symnav/telemetry";
import type { ProgramDependencies } from "../../../../src/program-dependencies.js";
import type {
  TelemetryIdentity,
  TelemetryIdentityProvider,
} from "../../../../src/telemetry/telemetry-identity.js";
import { FakeLanguageBackend } from "./fake-language-backend.js";

export type FakeProgramDependencies = ProgramDependencies;
export type FakeDependenciesOverrides = Partial<ProgramDependencies>;

export function fakeDependencies(
  overrides: FakeDependenciesOverrides = {},
): FakeProgramDependencies {
  return {
    stateDirectory: overrides.stateDirectory ?? "/state",
    daemonPolicy:
      overrides.daemonPolicy ?? DaemonPolicy.fromSystemMemory({ totalBytes: 8 * 1024 ** 3 }),
    daemonClient:
      overrides.daemonClient ??
      ({ execute: async () => undefined, control: async () => undefined } as unknown as DaemonClient),
    daemonEnabled: overrides.daemonEnabled ?? true,
    fs: overrides.fs ?? repoFs(),
    backends: overrides.backends ?? (() => [new FakeLanguageBackend()]),
    git: overrides.git ?? createFakeGitHistory(),
    recorder: overrides.recorder ?? { record: () => {} },
    clock: overrides.clock ?? createScriptedClock([1_000, 1_025]),
    telemetryEnabled: overrides.telemetryEnabled ?? false,
    ...(overrides.executionMode === undefined ? {} : { executionMode: overrides.executionMode }),
    identity: overrides.identity ?? createFakeIdentityProvider(),
    symnavVersion: overrides.symnavVersion ?? "0.0.0-test",
    ...(overrides.workspaceSession === undefined
      ? {}
      : { workspaceSession: overrides.workspaceSession }),
  };
}

export function createCapturingRecorder(): Recorder & {
  readonly events: readonly UsageEventInput[];
} {
  const events: UsageEventInput[] = [];
  return {
    events,
    record: (event) => {
      events.push(event);
    },
  };
}

export function createFakeGitHistory(entries: readonly HistoryEntry[] = []): GitHistory {
  return {
    recentHistory: () => Promise.resolve(entries),
  };
}

export function createScriptedClock(times: readonly number[]): Clock {
  let index = 0;
  return {
    now: () => {
      const time = times[Math.min(index, times.length - 1)] ?? 0;
      index += 1;
      return time;
    },
  };
}

export function createFakeIdentityProvider(
  identity: TelemetryIdentity = { workspaceId: "workspace-test", machineId: "machine-test" },
): TelemetryIdentityProvider {
  return {
    resolve: () => identity,
  };
}

function repoFs(): InMemoryFileSystem {
  return new InMemoryFileSystem({
    "/repo/.git/HEAD": "ref: refs/heads/main\n",
    "/repo/src/a.ts": "export const x = 1;",
  });
}
