import { describe, expect, it, vi } from "vitest";
import type { TelemetryFailureObserver, UsageEventInput } from "@symnav/telemetry";
import { fakeDependencies } from "../../test/integration/commands/helpers/fake-program-dependencies.js";
import { InvocationStateWriteCoordinator } from "./state-write-coordinator.js";
import { InvocationStateDependencies } from "./invocation-state-dependencies.js";

describe("InvocationStateDependencies", () => {
  it("disables identity and recorder access after the first observed write failure", () => {
    let observer: TelemetryFailureObserver | undefined;
    const base = fakeDependencies();
    const coordinator = new InvocationStateWriteCoordinator("/state");
    const record = vi.fn();
    const resolve = vi.fn(() => ({ machineId: "machine", workspaceId: "workspace" }));
    const dependencies = InvocationStateDependencies.create(
      {
        ...base,
        invocationTelemetry: (value) => {
          observer = value;
          return { recorder: { record }, identity: { resolve } };
        },
      },
      coordinator,
      true,
    );
    observer!.writeFailed({ path: "/state/usage.jsonl", osCode: "EACCES" });
    dependencies.recorder.record({} as UsageEventInput);
    expect(() =>
      dependencies.identity.resolve({ cwd: "/repo", workspaceRoot: undefined }),
    ).toThrow();
    expect(record).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(coordinator.access).toMatchObject({ kind: "disabled", failure: { osCode: "EACCES" } });
  });

  it("does not retain a previous request's failure on shared dependencies", () => {
    const observers: TelemetryFailureObserver[] = [];
    const base = fakeDependencies();
    const dependencies: typeof base = {
      ...base,
      invocationTelemetry: (observer: TelemetryFailureObserver) => {
        observers.push(observer);
        return { recorder: base.recorder, identity: base.identity };
      },
    };
    const first = new InvocationStateWriteCoordinator("/state");
    const second = new InvocationStateWriteCoordinator("/state");
    InvocationStateDependencies.create(dependencies, first, true);
    InvocationStateDependencies.create(dependencies, second, true);
    observers[0]!.writeFailed({ path: "/state/machine-id", osCode: "EPERM" });
    expect(first.access.kind).toBe("disabled");
    expect(second.access.kind).toBe("unused");
  });
});
