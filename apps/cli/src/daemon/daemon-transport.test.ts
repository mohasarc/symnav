import { describe, expectTypeOf, it } from "vitest";
import type {
  DaemonCommandDispatcher,
  DaemonDispatchRuntime,
} from "./daemon-command-dispatcher.js";
import type { DaemonController } from "./daemon-controller.js";
import type { DaemonRecordObserver } from "./daemon-record-observer.js";
import type { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
  DaemonRequestServer,
} from "./daemon-transport.js";
import type {
  DaemonProcessCoordinator,
  DaemonProcessCoordinatorOptions,
} from "./daemon-process-coordinator.js";

describe("daemon transport ports", () => {
  it("limits observers to lifecycle requests", () => {
    expectTypeOf<
      ConstructorParameters<typeof DaemonRecordObserver>[0]
    >().toEqualTypeOf<DaemonLifecycleRequestSender>();
  });

  it("limits startup to lifecycle and execution requests", () => {
    expectTypeOf<ConstructorParameters<typeof DaemonStartupCoordinator>[2]>().toEqualTypeOf<
      DaemonLifecycleRequestSender & DaemonExecutionRequester
    >();
    expectTypeOf<ConstructorParameters<typeof DaemonController>[1]>().toEqualTypeOf<
      DaemonLifecycleRequestSender & DaemonExecutionRequester
    >();
  });

  it("limits daemon processes to request serving", () => {
    expectTypeOf<DaemonProcessCoordinatorOptions["server"]>().toEqualTypeOf<DaemonRequestServer>();
    expectTypeOf<
      ConstructorParameters<typeof DaemonProcessCoordinator>[0]["server"]
    >().toEqualTypeOf<DaemonRequestServer>();
  });

  it("limits client execution to execution requests", () => {
    expectTypeOf<DaemonDispatchRuntime["transport"]>().toEqualTypeOf<DaemonExecutionRequester>();
    expectTypeOf<
      ConstructorParameters<typeof DaemonCommandDispatcher>[0]["createDependencies"]
    >().toBeFunction();
  });
});
