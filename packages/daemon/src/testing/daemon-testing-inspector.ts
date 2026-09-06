import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DaemonDiagnosticValue } from "../daemon-diagnostics.js";
import { DaemonDiagnosticValues } from "../daemon-diagnostics.js";
import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonRegistry } from "../registry/registry.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";

export interface DaemonTestingInstance {
  readonly workspaceRoot: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly state: "starting" | "ready";
}

export type DaemonTestingDiagnosticEvent = Readonly<Record<string, DaemonDiagnosticValue>>;

export interface DaemonTestingDiagnosticPage {
  readonly events: readonly DaemonTestingDiagnosticEvent[];
  readonly nextCursor: number;
}

export interface DaemonTestingSpoolUsage {
  readonly fileCount: number;
  readonly bytes: number;
}

export class DaemonTestingInspector {
  readonly #stateDirectory: string;

  constructor(canonicalStateDirectory: string) {
    this.#stateDirectory = canonicalStateDirectory;
  }

  listInstances(): readonly DaemonTestingInstance[] {
    try {
      return new DaemonRegistry(
        DaemonWorkspaceIdentity.registryDirectory(this.#stateDirectory),
        DaemonPolicy.currentSystem().values.startup,
      )
        .list()
        .map(({ workspaceRoot, pid, instanceId, state }) => ({
          workspaceRoot,
          pid,
          instanceId,
          state,
        }))
        .sort(
          (left, right) =>
            left.workspaceRoot.localeCompare(right.workspaceRoot) ||
            left.instanceId.localeCompare(right.instanceId),
        );
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(DaemonTestingInspector.errorCode(error) ?? "")) return [];
      throw error;
    }
  }

  hasStateArtifacts(): boolean {
    return existsSync(DaemonWorkspaceIdentity.registryDirectory(this.#stateDirectory));
  }

  readDiagnostics(canonicalWorkspaceRoot: string, cursor = 0): DaemonTestingDiagnosticPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid diagnostic cursor");
    const identity = DaemonWorkspaceIdentity.from(canonicalWorkspaceRoot, this.#stateDirectory);
    const events = DaemonTestingInspector.diagnosticEvents(identity);
    return { events: events.slice(cursor), nextCursor: events.length };
  }

  completionSpoolUsage(canonicalWorkspaceRoot: string): DaemonTestingSpoolUsage {
    const identity = DaemonWorkspaceIdentity.from(canonicalWorkspaceRoot, this.#stateDirectory);
    return DaemonTestingInspector.directoryUsage(identity.spoolDirectory);
  }

  private static diagnosticEvents(
    identity: DaemonWorkspaceIdentity,
  ): readonly DaemonTestingDiagnosticEvent[] {
    return DaemonTestingInspector.diagnosticPaths(identity).flatMap((path) =>
      DaemonTestingInspector.diagnosticEventsFrom(path),
    );
  }

  private static diagnosticPaths(identity: DaemonWorkspaceIdentity): readonly string[] {
    let names: readonly string[];
    try {
      names = readdirSync(identity.identityDirectory);
    } catch (error) {
      if (DaemonTestingInspector.errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const backupPattern = /^daemon\.log\.(\d+)$/;
    const backups = names
      .flatMap((name) => {
        const match = backupPattern.exec(name);
        return match === null ? [] : [{ name, index: Number(match[1]) }];
      })
      .sort((left, right) => right.index - left.index)
      .map(({ name }) => join(identity.identityDirectory, name));
    return names.includes("daemon.log") ? [...backups, identity.logPath] : backups;
  }

  private static diagnosticEventsFrom(path: string): readonly DaemonTestingDiagnosticEvent[] {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if (DaemonTestingInspector.errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return DaemonDiagnosticValues.isDiagnostics(value) ? [value] : [];
        } catch (error) {
          if (error instanceof SyntaxError) return [];
          throw error;
        }
      });
  }

  private static directoryUsage(directory: string): DaemonTestingSpoolUsage {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (DaemonTestingInspector.errorCode(error) === "ENOENT") return { fileCount: 0, bytes: 0 };
      throw error;
    }
    return entries.reduce<DaemonTestingSpoolUsage>(
      (usage, entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const nested = DaemonTestingInspector.directoryUsage(path);
          return {
            fileCount: usage.fileCount + nested.fileCount,
            bytes: usage.bytes + nested.bytes,
          };
        }
        if (!entry.isFile()) return usage;
        return {
          fileCount: usage.fileCount + 1,
          bytes: usage.bytes + lstatSync(path).size,
        };
      },
      { fileCount: 0, bytes: 0 },
    );
  }

  private static errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  }
}
