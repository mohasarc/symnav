import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export class DaemonWorkspaceIdentity {
  static registryDirectory(stateDirectory: string): string {
    return join(stateDirectory, "daemons");
  }

  static from(workspaceRoot: string, stateDirectory: string): DaemonWorkspaceIdentity {
    return new DaemonWorkspaceIdentity(workspaceRoot, stateDirectory);
  }

  readonly workspaceKey: string;
  readonly stateKey: string;
  readonly identityKey: string;
  readonly registryDirectory: string;
  readonly identityDirectory: string;
  readonly lockPath: string;
  readonly startupMutationPath: string;
  readonly logPath: string;
  readonly spoolDirectory: string;
  private readonly userKey: string;

  private constructor(
    readonly workspaceRoot: string,
    readonly stateDirectory: string,
  ) {
    this.workspaceKey = DaemonWorkspaceIdentity.hash(workspaceRoot);
    this.stateKey = DaemonWorkspaceIdentity.hash(stateDirectory);
    this.identityKey = DaemonWorkspaceIdentity.hash(`${this.workspaceKey}:${this.stateKey}`);
    this.registryDirectory = DaemonWorkspaceIdentity.registryDirectory(stateDirectory);
    this.identityDirectory = join(this.registryDirectory, this.identityKey);
    this.lockPath = join(this.identityDirectory, "startup.lock");
    this.startupMutationPath = join(this.identityDirectory, "startup.mutation");
    this.logPath = join(this.identityDirectory, "daemon.log");
    this.spoolDirectory = join(this.identityDirectory, "spool");
    this.userKey = DaemonWorkspaceIdentity.userIdentityKey();
  }

  endpoint(instanceId: string): string {
    const instanceKey = DaemonWorkspaceIdentity.hash(instanceId).slice(0, 12);
    const endpointName = `${this.identityKey.slice(0, 20)}-${instanceKey}`;
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\symnav-${this.userKey}-${endpointName}`;
    }
    return join(tmpdir(), `symnav-${this.userKey}`, `${endpointName}.sock`);
  }

  recordPath(instanceId: string): string {
    return join(this.identityDirectory, `${instanceId}.json`);
  }

  startupClaimPath(instanceId: string): string {
    return `${this.lockPath}.${instanceId}.claim`;
  }

  startupMutationClaimPath(token: string): string {
    return `${this.startupMutationPath}.${token}.claim`;
  }

  releasedStartupMutationPath(token: string): string {
    return `${this.startupMutationPath}.${token}.released`;
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
