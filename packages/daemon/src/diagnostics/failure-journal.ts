import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonFailureEvent } from "../daemon-failure.js";
import type { DaemonPolicyValues } from "../daemon-policy.js";
import type { DaemonClock } from "../lifecycle/daemon-clock.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import { DaemonFailureValues } from "./failure-values.js";

interface StoredFailure {
  readonly path: string;
  readonly bytes: number;
  readonly event: DaemonFailureEvent;
}

export class DaemonFailureJournal {
  private readonly byteBudget: number;

  public constructor(
    private readonly stateDirectory: string,
    policy: DaemonPolicyValues["diagnostics"],
    private readonly clock: Pick<DaemonClock, "wallNowMs">,
  ) {
    this.byteBudget = policy.logRotateBytes * (policy.logBackupCount + 1);
  }

  public async record(event: DaemonFailureEvent): Promise<void> {
    if (!DaemonFailureValues.isEvent(event)) throw new Error("Invalid daemon failure event");
    const contents = JSON.stringify(event);
    if (Buffer.byteLength(contents) > this.byteBudget)
      throw new Error("Daemon failure exceeds diagnostics budget");
    const identity = DaemonWorkspaceIdentity.from(event.workspaceRoot, this.stateDirectory);
    const directory = join(identity.identityDirectory, "failures");
    const temporary = join(directory, `${this.clock.wallNowMs()}.${randomUUID()}.tmp`);
    try {
      await DaemonFailureJournal.write(directory, () =>
        mkdir(directory, { recursive: true, mode: 0o700 }),
      );
      const file = await DaemonFailureJournal.write(temporary, () => open(temporary, "wx", 0o600));
      try {
        await DaemonFailureJournal.write(temporary, () => file.writeFile(contents, "utf8"));
        await DaemonFailureJournal.write(temporary, () => file.sync());
      } finally {
        await file.close();
      }
      try {
        await link(temporary, join(directory, DaemonFailureJournal.fileName(event)));
      } catch (error) {
        if (DaemonFailureJournal.errorCode(error) !== "EEXIST")
          throw DaemonStateWriteErrors.failedWrite(directory, error);
      }
      await this.retain(directory);
      if (process.platform !== "win32") {
        const container = await open(directory, "r");
        try {
          await DaemonFailureJournal.write(directory, () => container.sync());
        } finally {
          await container.close();
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch((error: unknown) => {
        throw DaemonStateWriteErrors.failedWrite(temporary, error);
      });
    }
  }

  public async recent(now: number): Promise<readonly DaemonFailureEvent[]> {
    const events = await this.retained();
    return events.filter(
      (event) => event.failure.timestamp >= now - 3_600_000 && event.failure.timestamp <= now,
    );
  }

  public async retained(): Promise<readonly DaemonFailureEvent[]> {
    const registry = DaemonWorkspaceIdentity.registryDirectory(this.stateDirectory);
    const directories = await DaemonFailureJournal.entries(registry);
    const failures = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readDirectory(join(registry, entry.name, "failures"))),
    );
    const events = failures
      .flat()
      .map(({ event }) => event)
      .sort(DaemonFailureJournal.compare);
    const observed = new Set<string>();
    return events.filter((event) => {
      const correlation = event.kind === "fallback" ? event.requestId : event.instanceId;
      const key = `${event.workspaceRoot}\0${event.kind}\0${correlation ?? event.eventId}`;
      if (observed.has(key)) return false;
      observed.add(key);
      return true;
    });
  }

  private async readDirectory(directory: string): Promise<readonly StoredFailure[]> {
    const entries = await DaemonFailureJournal.entries(directory);
    const failures = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
        .map(async (entry) => {
          const path = join(directory, entry.name);
          try {
            const bytes = (await stat(path)).size;
            if (bytes > this.byteBudget) return undefined;
            const event: unknown = JSON.parse(await readFile(path, "utf8"));
            if (
              !DaemonFailureValues.isEvent(event) ||
              DaemonFailureJournal.fileName(event) !== entry.name
            )
              return undefined;
            const identity = DaemonWorkspaceIdentity.from(event.workspaceRoot, this.stateDirectory);
            if (join(identity.identityDirectory, "failures") !== directory) return undefined;
            return { path, bytes, event };
          } catch (error) {
            if (error instanceof SyntaxError || DaemonFailureJournal.errorCode(error) === "ENOENT")
              return undefined;
            throw error;
          }
        }),
    );
    return failures.filter((failure): failure is StoredFailure => failure !== undefined);
  }

  private async retain(directory: string): Promise<void> {
    const entries = await DaemonFailureJournal.entries(directory);
    for (const entry of entries) {
      const timestamp = /^([0-9]+)\..+\.tmp$/u.exec(entry.name)?.[1];
      if (
        entry.isFile() &&
        timestamp !== undefined &&
        Number(timestamp) < this.clock.wallNowMs() - 60_000
      ) {
        const path = join(directory, entry.name);
        await DaemonFailureJournal.write(path, () => rm(path, { force: true }));
      }
    }
    const failures = [...(await this.readDirectory(directory))].sort((left, right) =>
      DaemonFailureJournal.compare(right.event, left.event),
    );
    let retainedBytes = 0;
    for (const failure of failures) {
      retainedBytes += failure.bytes;
      if (retainedBytes > this.byteBudget)
        await DaemonFailureJournal.write(failure.path, () => rm(failure.path, { force: true }));
    }
  }

  private static async write<T>(path: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw DaemonStateWriteErrors.failedWrite(path, error);
    }
  }

  private static fileName(event: DaemonFailureEvent): string {
    return `${createHash("sha256").update(event.eventId).digest("hex")}.json`;
  }

  private static compare(left: DaemonFailureEvent, right: DaemonFailureEvent): number {
    return (
      left.failure.timestamp - right.failure.timestamp || left.eventId.localeCompare(right.eventId)
    );
  }

  private static async entries(directory: string) {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (DaemonFailureJournal.errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  private static errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  }
}
