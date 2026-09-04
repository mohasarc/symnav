import { describe, expectTypeOf, it } from "vitest";
import type { DaemonCommandDispatcher, DaemonDispatchRuntime } from "./daemon-command-dispatcher.js";
import type { DaemonController } from "./daemon-controller.js";
import type { DaemonRecordObserver } from "./daemon-record-observer.js";
import type { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequester,
  DaemonRequestServer,
} from "./daemon-transport.js";
import type { WorkspaceDaemon, WorkspaceDaemonOptions } from "./workspace-daemon.js";

describe("daemon transport ports", () => {
  it("limits observers to lifecycle requests", () => {
    expectTypeOf<ConstructorParameters<typeof DaemonRecordObserver>[0]>().toEqualTypeOf<DaemonLifecycleRequester>();
  });

  it("limits startup to lifecycle and execution requests", () => {
    expectTypeOf<ConstructorParameters<typeof DaemonStartupCoordinator>[2]>().toEqualTypeOf<
      DaemonLifecycleRequester & DaemonExecutionRequester
    >();
    expectTypeOf<ConstructorParameters<typeof DaemonController>[1]>().toEqualTypeOf<
      DaemonLifecycleRequester & DaemonExecutionRequester
    >();
  });

  it("limits daemon processes to request serving", () => {
    expectTypeOf<WorkspaceDaemonOptions["transport"]>().toEqualTypeOf<DaemonRequestServer>();
    expectTypeOf<ConstructorParameters<typeof WorkspaceDaemon>[0]["transport"]>().toEqualTypeOf<DaemonRequestServer>();
  });

  it("limits client execution to execution requests", () => {
    expectTypeOf<DaemonDispatchRuntime["transport"]>().toEqualTypeOf<DaemonExecutionRequester>();
    expectTypeOf<ConstructorParameters<typeof DaemonCommandDispatcher>[0]["createDependencies"]>().toBeFunction();
  });
});
