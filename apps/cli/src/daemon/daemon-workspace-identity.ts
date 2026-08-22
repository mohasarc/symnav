import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export class DaemonWorkspaceIdentity {
  static from(workspaceRoot: string, stateDir: string): DaemonWorkspaceIdentity {
    return new DaemonWorkspaceIdentity(workspaceRoot, stateDir);
  }

  readonly workspaceKey: string;
  readonly registryDirectory: string;
  readonly lockPath: string;
  readonly logPath: string;
  private readonly userKey: string;

  private constructor(
    readonly workspaceRoot: string,
    stateDir: string,
  ) {
    this.workspaceKey = DaemonWorkspaceIdentity.hash(workspaceRoot);
    this.registryDirectory = join(stateDir, "daemons");
    this.lockPath = join(this.registryDirectory, `${this.workspaceKey}.lock`);
    this.logPath = join(this.registryDirectory, `${this.workspaceKey}.log`);
    this.userKey = DaemonWorkspaceIdentity.userIdentityKey();
  }

  endpoint(_instanceId: string): string {
    const endpointName = this.workspaceKey.slice(0, 20);
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\symnav-${this.userKey}-${endpointName}`;
    }
    return join(tmpdir(), `symnav-${this.userKey}`, `${endpointName}.sock`);
  }

  recordPath(instanceId: string): string {
    return join(this.registryDirectory, `${this.workspaceKey}.${instanceId}.json`);
  }

  startupClaimPath(instanceId: string): string {
    return `${this.lockPath}.${instanceId}.claim`;
  }

  releasedStartupLockPath(instanceId: string): string {
    return `${this.lockPath}.${instanceId}.released`;
  }

  startupOwnerPath(containerPath: string): string {
    return join(containerPath, "owner.json");
  }

  private static userIdentityKey(): string {
    const userIdentity =
      typeof process.getuid === "function" ? String(process.getuid()) : userInfo().username;
    return DaemonWorkspaceIdentity.hash(userIdentity).slice(0, 8);
  }

  private static hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
