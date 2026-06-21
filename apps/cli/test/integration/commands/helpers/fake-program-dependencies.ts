import { InMemoryFileSystem } from "@symnav/core";
import type { LanguageBackend } from "@symnav/core";
import type { Clock, Recorder, UsageEventInput } from "@symnav/telemetry";
import type { ProgramDependencies } from "../../../../src/program-dependencies.js";
import type {
  TelemetryIdentity,
  TelemetryIdentityProvider,
} from "../../../../src/telemetry/telemetry-identity.js";
import { FakeLanguageBackend } from "./fake-language-backend.js";

export type FakeProgramDependencies = ProgramDependencies & {
  recorder: Recorder;
  clock: Clock;
  telemetryEnabled: boolean;
  identity: TelemetryIdentityProvider;
  symnavVersion: string;
};

export interface FakeDependenciesOverrides {
  readonly fs?: InMemoryFileSystem;
  readonly backends?: () => readonly LanguageBackend[];
  readonly recorder?: Recorder;
  readonly clock?: Clock;
  readonly telemetryEnabled?: boolean;
  readonly identity?: TelemetryIdentityProvider;
  readonly symnavVersion?: string;
}

export function fakeDependencies(
  overrides: FakeDependenciesOverrides = {},
): FakeProgramDependencies {
  return {
    fs: overrides.fs ?? repoFs(),
    backends: overrides.backends ?? (() => [new FakeLanguageBackend()]),
    recorder: overrides.recorder ?? { record: () => {} },
    clock: overrides.clock ?? createScriptedClock([1_000, 1_025]),
    telemetryEnabled: overrides.telemetryEnabled ?? false,
    identity: overrides.identity ?? createFakeIdentityProvider(),
    symnavVersion: overrides.symnavVersion ?? "0.0.0-test",
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
