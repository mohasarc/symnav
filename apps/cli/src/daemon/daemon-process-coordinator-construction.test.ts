import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonProcessCoordinator,
  type DaemonProcessCoordinatorOptions,
} from "./daemon-process-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

describe("DaemonProcessCoordinator construction", () => {
  const roots: string[] = [];

  afterEach(() => {
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
    const coordinates = {
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
});
