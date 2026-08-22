import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import { DaemonController } from "./daemon-controller.js";
import type { DaemonProcessTerminator } from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("DaemonController", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });
});

class ControllerTransport {
  request(_endpoint: string, _request: DaemonRequest): Promise<DaemonResponse> {
    throw new Error("Starting-daemon cancellation must not use transport");
  }
}

class ControllerTerminator implements DaemonProcessTerminator {
  readonly alive: Set<number>;

  constructor(alive: readonly number[]) {
    this.alive = new Set(alive);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.alive.delete(pid);
  }
}

function temporaryDirectory(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-controller-"));
  roots.push(root);
  return root;
}

function startingRecord(
  identity: DaemonWorkspaceIdentity,
  instanceId = "starting",
): DaemonRecord {
  return {
    schemaVersion: 1,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    instanceId,
    processToken: `${instanceId}-process`,
    endpoint: identity.endpoint(instanceId),
    pid: 0,
    state: "starting",
    startedAt: 10,
    memoryCapBytes: 256 * 1024 * 1024,
  };
}
