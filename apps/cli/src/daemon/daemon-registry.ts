import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
}

export interface StartupLease {
  readonly instanceId: string;
  release(): void;
}

class RegistryStartupLease implements StartupLease {
  constructor(
    private readonly _registry: DaemonRegistry,
    private readonly _identity: DaemonWorkspaceIdentity,
    readonly instanceId: string,
  ) {}

  release(): void {
    throw new Error("Startup lease release is not implemented");
  }
}

export class DaemonRegistry {
  constructor(private readonly registryDirectory: string) {}

  read(identity: DaemonWorkspaceIdentity): DaemonRecord | undefined {
    return this.records(identity).find((record) => DaemonRegistry.isCurrentRecord(record));
  }

  readInstance(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
  ): DaemonRecord | undefined {
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
    mkdirSync(this.registryDirectory, { recursive: true, mode: 0o700 });
    const recordPath = join(
      this.registryDirectory,
      `${record.workspaceKey}.${record.instanceId}.json`,
    );
    const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, recordPath);
  }

  writeIfStartupOwner(_identity: DaemonWorkspaceIdentity, _record: DaemonRecord): boolean {
    throw new Error("Daemon readiness publication is not implemented");
  }

  acquireStartup(
    _identity: DaemonWorkspaceIdentity,
    _instanceId: string,
  ): StartupLease | undefined {
    throw new Error("Daemon startup election is not implemented");
  }

  startupOwner(_identity: DaemonWorkspaceIdentity): StartupOwner | undefined {
    throw new Error("Daemon startup election is not implemented");
  }

  isStartupOwner(_identity: DaemonWorkspaceIdentity, _instanceId: string): boolean {
    throw new Error("Daemon startup election is not implemented");
  }

  removeStartupLockIfInstance(
    _identity: DaemonWorkspaceIdentity,
    _instanceId: string,
  ): boolean {
    throw new Error("Daemon startup cleanup is not implemented");
  }

  removeIfInstance(_identity: DaemonWorkspaceIdentity, _instanceId: string): void {
    throw new Error("Daemon record removal is not implemented");
  }

  list(): readonly DaemonRecord[] {
    return this.recordNames()
      .map((name) => ({ name, record: this.readStoredPath(join(this.registryDirectory, name)) }))
      .filter(
        (entry): entry is { readonly name: string; readonly record: DaemonRecord } =>
          entry.record !== undefined &&
          DaemonRegistry.isCurrentRecord(entry.record) &&
          this.recordMatchesFile(entry.name, entry.record),
      )
      .map(({ record }) => record);
  }

  private records(identity: DaemonWorkspaceIdentity): readonly DaemonRecord[] {
    const prefix = `${identity.workspaceKey}.`;
    return this.recordNames()
      .filter((name) => name.startsWith(prefix))
      .map((name) => this.readStoredPath(join(this.registryDirectory, name)))
      .filter(
        (record): record is DaemonRecord =>
          record !== undefined && DaemonRegistry.matchesIdentity(record, identity),
      )
      .sort(
        (left, right) =>
          right.startedAt - left.startedAt || right.instanceId.localeCompare(left.instanceId),
      );
  }

  private recordNames(): readonly string[] {
    try {
      return readdirSync(this.registryDirectory).filter((name) => name.endsWith(".json"));
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

  private recordMatchesFile(name: string, record: DaemonRecord): boolean {
    const expectedIdentity = DaemonWorkspaceIdentity.from(
      record.workspaceRoot,
      dirname(this.registryDirectory),
    );
    return (
      expectedIdentity.registryDirectory === this.registryDirectory &&
      DaemonRegistry.matchesIdentity(record, expectedIdentity) &&
      name === `${expectedIdentity.workspaceKey}.${record.instanceId}.json`
    );
  }

  private static matchesIdentity(record: DaemonRecord, identity: DaemonWorkspaceIdentity): boolean {
    return (
      record.workspaceRoot === identity.workspaceRoot &&
      record.workspaceKey === identity.workspaceKey &&
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
      typeof record.instanceId === "string" &&
      typeof record.processToken === "string" &&
      typeof record.endpoint === "string" &&
      Number.isInteger(record.pid) &&
      (record.state === "starting" || record.state === "ready") &&
      typeof record.startedAt === "number" &&
      typeof record.memoryCapBytes === "number" &&
      (record.readyAt === undefined || typeof record.readyAt === "number") &&
      (record.fileCount === undefined || typeof record.fileCount === "number") &&
      (record.lastNavigationAt === undefined || typeof record.lastNavigationAt === "number")
    );
  }

  private static errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    return (error as { readonly code?: string }).code;
  }
}
