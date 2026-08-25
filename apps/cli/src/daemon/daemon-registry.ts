import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "./daemon-protocol.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

export interface StartupOwner {
  readonly instanceId: string;
  readonly ownerPid: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly revision: string;
}

export const DAEMON_STARTUP_TIMEOUT_MS = 15_000;

export interface StartupLease {
  readonly instanceId: string;
  release(): void;
}

interface StartupMutationOwner {
  readonly ownerPid: number;
  readonly acquiredAt: number;
  readonly token: string;
}

class RegistryStartupMutationLease {
  private released = false;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly owner: StartupMutationOwner,
  ) {}

  isOwned(): boolean {
    return this.registry.isStartupMutationOwner(this.identity, this.owner);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.registry.releaseStartupMutation(this.identity, this.owner);
  }
}

class RegistryStartupLease implements StartupLease {
  private released = false;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
    readonly instanceId: string,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.registry.removeStartupLockIfInstance(this.identity, this.instanceId);
  }
}

export class DaemonRegistry {
  constructor(
    private readonly registryDirectory: string,
    private readonly platform = process.platform,
    private readonly renamePath: typeof renameSync = renameSync,
  ) {}

  read(identity: DaemonWorkspaceIdentity): DaemonRecord | undefined {
    return this.records(identity).find((record) => DaemonRegistry.isCurrentRecord(record));
  }

  readInstance(identity: DaemonWorkspaceIdentity, instanceId: string): DaemonRecord | undefined {
    const record = this.readStoredPath(identity.recordPath(instanceId));
    return record !== undefined &&
      DaemonRegistry.isCurrentRecord(record) &&
      DaemonRegistry.matchesIdentity(record, identity)
      ? record
      : undefined;
  }

  readStored(identity: DaemonWorkspaceIdentity): DaemonRecord | undefined {
    return this.records(identity)[0];
  }

  readStoredInstance(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
  ): DaemonRecord | undefined {
    const record = this.readStoredPath(identity.recordPath(instanceId));
    return record !== undefined && DaemonRegistry.matchesIdentity(record, identity)
      ? record
      : undefined;
  }

  write(record: DaemonRecord): void {
    const identity = DaemonWorkspaceIdentity.from(
      record.workspaceRoot,
      dirname(this.registryDirectory),
    );
    mkdirSync(identity.identityDirectory, { recursive: true, mode: 0o700 });
    const recordPath = identity.recordPath(record.instanceId);
    const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, recordPath);
  }

  writeIfStartupOwner(identity: DaemonWorkspaceIdentity, record: DaemonRecord): boolean {
    if (!this.isStartupOwner(identity, record.instanceId)) return false;
    const current = this.readInstance(identity, record.instanceId);
    if (current?.state !== "starting") return false;
    this.write(record);
    if (this.isStartupOwner(identity, record.instanceId)) return true;
    this.removeIfInstance(identity, record.instanceId);
    return false;
  }

  writeStartingIfStartupOwner(identity: DaemonWorkspaceIdentity, record: DaemonRecord): boolean {
    if (record.state !== "starting" || !this.isStartupOwner(identity, record.instanceId)) {
      return false;
    }
    this.write(record);
    if (this.isStartupOwner(identity, record.instanceId)) return true;
    this.removeIfInstance(identity, record.instanceId);
    return false;
  }

  acquireStartup(identity: DaemonWorkspaceIdentity, instanceId: string): StartupLease | undefined {
    mkdirSync(identity.identityDirectory, { recursive: true, mode: 0o700 });
    const acquiredAt = Date.now();
    const owner: StartupOwner = {
      instanceId,
      ownerPid: process.pid,
      acquiredAt,
      heartbeatAt: acquiredAt,
      revision: randomUUID(),
    };
    const claimPath = identity.startupClaimPath(instanceId);
    mkdirSync(claimPath, { mode: 0o700 });
    writeFileSync(identity.startupOwnerPath(claimPath), JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      renameSync(claimPath, identity.lockPath);
      return new RegistryStartupLease(this, identity, instanceId);
    } catch (error) {
      rmSync(claimPath, { recursive: true, force: true });
      if (existsSync(identity.lockPath)) return undefined;
      throw error;
    }
  }

  refreshStartupOwner(identity: DaemonWorkspaceIdentity, instanceId: string): boolean {
    const mutation = this.beginStartupMutation(identity);
    if (mutation === undefined) return false;
    try {
      const owner = this.startupOwner(identity);
      if (owner?.instanceId !== instanceId) return false;
      const ownerPath = identity.startupOwnerPath(identity.lockPath);
      const temporaryPath = `${identity.lockPath}.${process.pid}.${randomUUID()}.owner.tmp`;
      writeFileSync(
        temporaryPath,
        JSON.stringify({ ...owner, heartbeatAt: Date.now(), revision: randomUUID() }),
        { encoding: "utf8", mode: 0o600 },
      );
      if (
        !mutation.isOwned() ||
        !DaemonRegistry.sameStartupOwner(this.startupOwner(identity), owner)
      ) {
        rmSync(temporaryPath, { force: true });
        return false;
      }
      try {
        this.replaceStartupOwner(temporaryPath, ownerPath);
        return this.isStartupOwner(identity, instanceId);
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        if (DaemonRegistry.errorCode(error) === "ENOENT") return false;
        throw error;
      }
    } finally {
      mutation.release();
    }
  }

  startupOwnerIsWithinGrace(
    owner: StartupOwner,
    graceMs = DAEMON_STARTUP_TIMEOUT_MS,
    now = Date.now(),
  ): boolean {
    return now - owner.heartbeatAt <= graceMs;
  }

  startupOwner(identity: DaemonWorkspaceIdentity): StartupOwner | undefined {
    try {
      const value: unknown = JSON.parse(
        readFileSync(identity.startupOwnerPath(identity.lockPath), "utf8"),
      );
      return DaemonRegistry.isStartupOwner(value) ? value : undefined;
    } catch (error) {
      if (DaemonRegistry.errorCode(error) === "ENOENT" || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  isStartupOwner(identity: DaemonWorkspaceIdentity, instanceId: string): boolean {
    return this.startupOwner(identity)?.instanceId === instanceId;
  }

  removeStartupLockIfInstance(identity: DaemonWorkspaceIdentity, instanceId: string): boolean {
    const releasedPath = identity.releasedStartupLockPath(instanceId);
    const owner = this.startupOwner(identity);
    if (owner?.instanceId !== instanceId) {
      return DaemonRegistry.readStartupOwner(identity, releasedPath)?.instanceId === instanceId;
    }
    try {
      renameSync(identity.lockPath, releasedPath);
      return true;
    } catch (error) {
      if (DaemonRegistry.readStartupOwner(identity, releasedPath)?.instanceId === instanceId) {
        return true;
      }
      throw error;
    }
  }

  removeStartupLockIfOwner(
    identity: DaemonWorkspaceIdentity,
    observedOwner: StartupOwner,
  ): boolean {
    const mutation = this.beginStartupMutation(identity);
    if (mutation === undefined) return false;
    try {
      if (
        !mutation.isOwned() ||
        !DaemonRegistry.sameStartupOwner(this.startupOwner(identity), observedOwner)
      ) {
        return false;
      }
      return this.removeStartupLockIfInstance(identity, observedOwner.instanceId);
    } finally {
      mutation.release();
    }
  }

  removeIfInstance(identity: DaemonWorkspaceIdentity, instanceId: string): void {
    rmSync(identity.recordPath(instanceId), { force: true });
  }

  list(): readonly DaemonRecord[] {
    return this.recordPaths()
      .map((path) => ({ path, record: this.readStoredPath(path) }))
      .filter(
        (entry): entry is { readonly path: string; readonly record: DaemonRecord } =>
          entry.record !== undefined &&
          DaemonRegistry.isCurrentRecord(entry.record) &&
          this.recordMatchesFile(entry.path, entry.record),
      )
      .map(({ record }) => record);
  }

  private records(identity: DaemonWorkspaceIdentity): readonly DaemonRecord[] {
    return this.recordPathsIn(identity.identityDirectory)
      .map((path) => this.readStoredPath(path))
      .filter(
        (record): record is DaemonRecord =>
          record !== undefined && DaemonRegistry.matchesIdentity(record, identity),
      )
      .sort(
        (left, right) =>
          right.startedAt - left.startedAt || right.instanceId.localeCompare(left.instanceId),
      );
  }

  isStartupMutationOwner(identity: DaemonWorkspaceIdentity, owner: StartupMutationOwner): boolean {
    return DaemonRegistry.sameStartupMutationOwner(
      DaemonRegistry.readStartupMutationOwner(identity, identity.startupMutationPath),
      owner,
    );
  }

  releaseStartupMutation(identity: DaemonWorkspaceIdentity, owner: StartupMutationOwner): void {
    if (!this.isStartupMutationOwner(identity, owner)) return;
    const releasedPath = identity.releasedStartupMutationPath(owner.token);
    try {
      renameSync(identity.startupMutationPath, releasedPath);
      if (
        DaemonRegistry.sameStartupMutationOwner(
          DaemonRegistry.readStartupMutationOwner(identity, releasedPath),
          owner,
        )
      ) {
        rmSync(releasedPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (DaemonRegistry.errorCode(error) === "ENOENT") return;
      throw error;
    }
  }

  private beginStartupMutation(
    identity: DaemonWorkspaceIdentity,
  ): RegistryStartupMutationLease | undefined {
    const claimed = this.claimStartupMutation(identity);
    if (claimed !== undefined) return claimed;
    const observedOwner = DaemonRegistry.readStartupMutationOwner(
      identity,
      identity.startupMutationPath,
    );
    if (
      observedOwner !== undefined &&
      DaemonRegistry.processIsAlive(observedOwner.ownerPid) &&
      Date.now() - observedOwner.acquiredAt <= DAEMON_STARTUP_TIMEOUT_MS
    ) {
      return undefined;
    }
    if (!this.recoverStartupMutation(identity, observedOwner)) return undefined;
    return this.claimStartupMutation(identity);
  }

  private claimStartupMutation(
    identity: DaemonWorkspaceIdentity,
  ): RegistryStartupMutationLease | undefined {
    mkdirSync(identity.identityDirectory, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const owner: StartupMutationOwner = {
      ownerPid: process.pid,
      acquiredAt: Date.now(),
      token,
    };
    const claimPath = identity.startupMutationClaimPath(token);
    mkdirSync(claimPath, { mode: 0o700 });
    writeFileSync(identity.startupOwnerPath(claimPath), JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      renameSync(claimPath, identity.startupMutationPath);
      return new RegistryStartupMutationLease(this, identity, owner);
    } catch (error) {
      rmSync(claimPath, { recursive: true, force: true });
      if (existsSync(identity.startupMutationPath)) return undefined;
      throw error;
    }
  }

  private recoverStartupMutation(
    identity: DaemonWorkspaceIdentity,
    observedOwner: StartupMutationOwner | undefined,
  ): boolean {
    const currentOwner = DaemonRegistry.readStartupMutationOwner(
      identity,
      identity.startupMutationPath,
    );
    if (!DaemonRegistry.sameOptionalStartupMutationOwner(currentOwner, observedOwner)) return false;
    const recoveryToken = observedOwner?.token ?? "ownerless";
    const releasedPath = identity.releasedStartupMutationPath(recoveryToken);
    try {
      renameSync(identity.startupMutationPath, releasedPath);
      return true;
    } catch (error) {
      if (existsSync(releasedPath)) return true;
      if (DaemonRegistry.errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  private recordPaths(): readonly string[] {
    try {
      return readdirSync(this.registryDirectory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? this.recordPathsIn(join(this.registryDirectory, entry.name)) : [],
      );
    } catch (error) {
      if (DaemonRegistry.errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  private recordPathsIn(identityDirectory: string): readonly string[] {
    try {
      return readdirSync(identityDirectory, { withFileTypes: true }).flatMap((entry) =>
        entry.isFile() && entry.name.endsWith(".json") ? [join(identityDirectory, entry.name)] : [],
      );
    } catch (error) {
      if (DaemonRegistry.errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  private readStoredPath(recordPath: string): DaemonRecord | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
      return DaemonRegistry.isStoredRecord(value) ? value : undefined;
    } catch (error) {
      if (DaemonRegistry.errorCode(error) === "ENOENT" || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private recordMatchesFile(path: string, record: DaemonRecord): boolean {
    const expectedIdentity = DaemonWorkspaceIdentity.from(
      record.workspaceRoot,
      dirname(this.registryDirectory),
    );
    return (
      expectedIdentity.registryDirectory === this.registryDirectory &&
      DaemonRegistry.matchesIdentity(record, expectedIdentity) &&
      path === expectedIdentity.recordPath(record.instanceId)
    );
  }

  private static matchesIdentity(record: DaemonRecord, identity: DaemonWorkspaceIdentity): boolean {
    return (
      record.workspaceRoot === identity.workspaceRoot &&
      record.workspaceKey === identity.workspaceKey &&
      record.stateKey === identity.stateKey &&
      record.identityKey === identity.identityKey &&
      record.endpoint === identity.endpoint(record.instanceId)
    );
  }

  private static isCurrentRecord(record: DaemonRecord): boolean {
    if (
      record.schemaVersion !== DAEMON_RECORD_SCHEMA_VERSION ||
      record.protocolVersion !== DAEMON_PROTOCOL_VERSION
    )
      return false;
    if (record.state === "starting") {
      return record.readyAt === undefined && record.fileCount === undefined;
    }
    return typeof record.readyAt === "number" && typeof record.fileCount === "number";
  }

  private static isStoredRecord(value: unknown): value is DaemonRecord {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      Number.isInteger(record.schemaVersion) &&
      Number.isInteger(record.protocolVersion) &&
      typeof record.symnavVersion === "string" &&
      typeof record.workspaceRoot === "string" &&
      typeof record.workspaceKey === "string" &&
      typeof record.stateKey === "string" &&
      typeof record.identityKey === "string" &&
      typeof record.instanceId === "string" &&
      typeof record.processToken === "string" &&
      typeof record.endpoint === "string" &&
      Number.isInteger(record.pid) &&
      (record.state === "starting" || record.state === "ready") &&
      typeof record.startedAt === "number" &&
      typeof record.memoryCapBytes === "number" &&
      (record.readyAt === undefined || typeof record.readyAt === "number") &&
      (record.fileCount === undefined || typeof record.fileCount === "number") &&
      (record.memoryBytes === undefined || typeof record.memoryBytes === "number") &&
      (record.lastNavigationAt === undefined || typeof record.lastNavigationAt === "number")
    );
  }

  private static isStartupOwner(value: unknown): value is StartupOwner {
    if (typeof value !== "object" || value === null) return false;
    const owner = value as Record<string, unknown>;
    return (
      typeof owner.instanceId === "string" &&
      Number.isInteger(owner.ownerPid) &&
      typeof owner.acquiredAt === "number" &&
      typeof owner.heartbeatAt === "number" &&
      typeof owner.revision === "string"
    );
  }

  private static sameStartupOwner(
    current: StartupOwner | undefined,
    observed: StartupOwner,
  ): boolean {
    return (
      current?.instanceId === observed.instanceId &&
      current.ownerPid === observed.ownerPid &&
      current.acquiredAt === observed.acquiredAt &&
      current.heartbeatAt === observed.heartbeatAt &&
      current.revision === observed.revision
    );
  }

  private static sameStartupMutationOwner(
    current: StartupMutationOwner | undefined,
    observed: StartupMutationOwner,
  ): boolean {
    return (
      current?.ownerPid === observed.ownerPid &&
      current.acquiredAt === observed.acquiredAt &&
      current.token === observed.token
    );
  }

  private static sameOptionalStartupMutationOwner(
    current: StartupMutationOwner | undefined,
    observed: StartupMutationOwner | undefined,
  ): boolean {
    if (current === undefined || observed === undefined) return current === observed;
    return DaemonRegistry.sameStartupMutationOwner(current, observed);
  }

  private static readStartupOwner(
    identity: DaemonWorkspaceIdentity,
    path: string,
  ): StartupOwner | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(identity.startupOwnerPath(path), "utf8"));
      return DaemonRegistry.isStartupOwner(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private static readStartupMutationOwner(
    identity: DaemonWorkspaceIdentity,
    path: string,
  ): StartupMutationOwner | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(identity.startupOwnerPath(path), "utf8"));
      return DaemonRegistry.isStartupMutationOwner(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private static isStartupMutationOwner(value: unknown): value is StartupMutationOwner {
    if (typeof value !== "object" || value === null) return false;
    const owner = value as Record<string, unknown>;
    return (
      Number.isInteger(owner.ownerPid) &&
      typeof owner.acquiredAt === "number" &&
      typeof owner.token === "string"
    );
  }

  private static processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return DaemonRegistry.errorCode(error) === "EPERM";
    }
  }

  private replaceStartupOwner(temporaryPath: string, ownerPath: string): void {
    if (this.platform !== "win32") {
      this.renamePath(temporaryPath, ownerPath);
      return;
    }
    const previousPath = `${ownerPath}.${process.pid}.${randomUUID()}.previous`;
    this.renamePath(ownerPath, previousPath);
    try {
      this.renamePath(temporaryPath, ownerPath);
    } catch (error) {
      try {
        this.renamePath(previousPath, ownerPath);
      } catch {}
      throw error;
    }
    try {
      rmSync(previousPath, { force: true });
    } catch {}
  }

  private static errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    return (error as { readonly code?: string }).code;
  }
}
