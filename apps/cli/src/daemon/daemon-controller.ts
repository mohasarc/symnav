import type { DaemonRegistry } from "./daemon-registry.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
import type { DaemonRecord, DaemonStopResult } from "./daemon-protocol.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

interface DaemonControllerOptions {
  readonly processTerminator?: DaemonProcessTerminator;
  readonly now?: () => number;
}

export class DaemonController {
  private readonly processTerminator: DaemonProcessTerminator;
  private readonly now: () => number;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
    private readonly stateDirectory: string,
    options: DaemonControllerOptions = {},
  ) {
    this.processTerminator = options.processTerminator ?? new NodeDaemonProcessTerminator();
    this.now = options.now ?? Date.now;
  }

  async stop(workspaceRoot: string): Promise<DaemonStopResult> {
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    const record = this.registry.read(identity);
    if (record?.state !== "starting") {
      throw new Error("Ready daemon stopping is not available");
    }
    return this.stopStarting(identity, record);
  }

  private stopStarting(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): DaemonStopResult {
    const owner = this.registry.startupOwner(identity);
    if (
      owner?.instanceId !== record.instanceId ||
      !this.processTerminator.isAlive(owner.ownerPid)
    ) {
      if (owner?.instanceId === record.instanceId) {
        this.registry.removeStartupLockIfInstance(identity, record.instanceId);
      }
      this.registry.removeIfInstance(identity, record.instanceId);
      return { status: "not-running", workspaceRoot: record.workspaceRoot };
    }
    this.registry.removeStartupLockIfInstance(identity, record.instanceId);
    this.registry.removeIfInstance(identity, record.instanceId);
    return record.pid > 0
      ? { status: "stopped", workspaceRoot: record.workspaceRoot, pid: record.pid }
      : { status: "not-running", workspaceRoot: record.workspaceRoot };
  }
}
