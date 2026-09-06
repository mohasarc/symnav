import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonPolicy,
  type DaemonCommandName,
  type DaemonExecutorRequest,
  type DaemonOutputSink,
} from "@symnav/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptedExecutionSession } from "../execution/accepted-execution-session.js";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "../worker/navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "../worker/worker-protocol.js";
import {
  DaemonProcessCoordinator,
  type DaemonProcessCoordinatorOptions,
} from "./process-coordinator.js";
import type { DaemonIdentityCoordinates, DaemonServer } from "../transport/protocol.js";
import type { DaemonRequestHandler, DaemonRequestServer } from "../transport/contracts.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { TestDaemonRegistry as DaemonRegistry } from "../../test/helpers/daemon-registry.js";

interface CoordinatorPrototypeTestAccess {
  recoverWorkerExit(exit: DaemonNavigationWorkerExit): Promise<void>;
  initiateResourceDrain(): Promise<void>;
  workspaceDeletedAfterDelivery(): Promise<void>;
  drainAndShutdown(reason: "idle"): Promise<void>;
}

interface CoordinatorCompositionTestAccess {
  readonly workerManager: {
    readonly options: {
      readonly exitRecovery: { recover(exit: DaemonNavigationWorkerExit): Promise<void> };
      readonly onActiveResourceInterruption: (cause: "hard-pressure") => void;
    };
  };
  readonly resourceSupervisor: {
    readonly options: {
      readonly scheduleAtTurnBoundary: (operation: () => Promise<void>) => Promise<void>;
      readonly drain: () => Promise<void>;
    };
  };
  readonly acceptedExecutionSession: {
    readonly options: {
      readonly processLifecycle: { workspaceDeletedAfterDelivery(): Promise<void> };
    };
  };
  readonly lifetime: { readonly onIdle: () => Promise<void> };
}

describe("DaemonProcessCoordinator construction", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it.each([
    ["workspaceRoot", "/other-workspace"],
    ["workspaceKey", "other-workspace-key"],
    ["stateKey", "other-state-key"],
    ["identityKey", "other-identity-key"],
    ["instanceId", "other-instance"],
    ["endpoint", "other-endpoint"],
  ] as const)("rejects a mismatched %s before observing a component", (field, value) => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-coordinator-construction-"));
    roots.push(stateDirectory);
    const identity = DaemonWorkspaceIdentity.from("/workspace", stateDirectory);
    const coordinates: DaemonIdentityCoordinates = {
      workspaceRoot: identity.workspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId: "instance",
      processToken: "token",
      endpoint: identity.endpoint("instance"),
      [field]: value,
    };
    let componentObserved = false;
    const options = {
      identity,
      coordinates,
      get policy(): never {
        componentObserved = true;
        throw new Error("Coordinator observed policy before validating coordinates");
      },
    } as unknown as DaemonProcessCoordinatorOptions;

    expect(() => new DaemonProcessCoordinator(options)).toThrow(
      "Daemon process identity does not match configuration",
    );
    expect(componentObserved).toBe(false);
  });

  it("binds every cyclic callback without routing during construction", async () => {
    const acceptedInterruption = vi
      .spyOn(AcceptedExecutionSession.prototype, "markActiveResourceInterrupted")
      .mockImplementation(() => undefined);
    const acceptedTurnBoundary = vi
      .spyOn(AcceptedExecutionSession.prototype, "scheduleAtTurnBoundary")
      .mockResolvedValue(undefined);
    const coordinatorPrototype =
      DaemonProcessCoordinator.prototype as unknown as CoordinatorPrototypeTestAccess;
    const workerExit = vi
      .spyOn(coordinatorPrototype, "recoverWorkerExit")
      .mockResolvedValue(undefined);
    const resourceDrain = vi
      .spyOn(coordinatorPrototype, "initiateResourceDrain")
      .mockResolvedValue(undefined);
    const acceptedCallback = vi
      .spyOn(coordinatorPrototype, "workspaceDeletedAfterDelivery")
      .mockResolvedValue(undefined);
    const idleCallback = vi
      .spyOn(coordinatorPrototype, "drainAndShutdown")
      .mockResolvedValue(undefined);
    const coordinator = createCoordinator(roots);
    const composition = coordinator as unknown as CoordinatorCompositionTestAccess;

    expect(
      [
        workerExit,
        acceptedInterruption,
        acceptedTurnBoundary,
        resourceDrain,
        acceptedCallback,
        idleCallback,
      ].map((route) => route.mock.calls.length),
    ).toEqual([0, 0, 0, 0, 0, 0]);

    await composition.workerManager.options.exitRecovery.recover({
      generation: 1,
      cause: "closed",
    });
    composition.workerManager.options.onActiveResourceInterruption("hard-pressure");
    await composition.resourceSupervisor.options.scheduleAtTurnBoundary(async () => undefined);
    await composition.resourceSupervisor.options.drain();
    await composition.acceptedExecutionSession.options.processLifecycle.workspaceDeletedAfterDelivery();
    await composition.lifetime.onIdle();

    expect(
      [
        workerExit,
        acceptedInterruption,
        acceptedTurnBoundary,
        resourceDrain,
        acceptedCallback,
        idleCallback,
      ].map((route) => route.mock.calls.length),
    ).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

function createCoordinator(roots: string[]): DaemonProcessCoordinator {
  const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-coordinator-composition-"));
  roots.push(stateDirectory);
  const identity = DaemonWorkspaceIdentity.from("/workspace", stateDirectory);
  const instanceId = "instance";
  return new DaemonProcessCoordinator({
    identity,
    coordinates: {
      workspaceRoot: identity.workspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken: "token",
      endpoint: identity.endpoint(instanceId),
    },
    productVersion: "test",
    policy: DaemonPolicy.currentSystem(),
    registry: new DaemonRegistry(identity.registryDirectory),
    server: new InertRequestServer(),
    navigationWorker: new InertNavigationWorker(),
    clock: new NodeDaemonClock(),
  });
}

class InertRequestServer implements DaemonRequestServer {
  async listen(_endpoint: string, _handler: DaemonRequestHandler): Promise<DaemonServer> {
    throw new Error("Construction must not listen");
  }

  async removeUnavailableEndpoint(_endpoint: string): Promise<boolean> {
    return false;
  }
}

class InertNavigationWorker implements DaemonNavigationWorker {
  readonly generation = 1;
  readonly exited = new Promise<DaemonNavigationWorkerExit>(() => undefined);

  async start(_workspaceRoot: string): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Construction must not start the worker");
  }

  async execute(
    _requestId: string,
    _commandName: DaemonCommandName,
    _request: DaemonExecutorRequest,
    _output: DaemonOutputSink,
  ): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Construction must not execute navigation");
  }

  async releaseTransientResources(): Promise<DaemonNavigationWorkerResponse> {
    throw new Error("Construction must not release resources");
  }

  async drainAndClose(): Promise<void> {
    throw new Error("Construction must not close the worker");
  }

  async terminate(): Promise<void> {
    throw new Error("Construction must not terminate the worker");
  }
}
