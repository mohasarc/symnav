import type { IdGenerator } from "./id-generator.js";
import { usageLogPath } from "./state-dir.js";
import {
  SCHEMA_VERSION,
  type OutcomeReport,
  type UsageEvent,
  type UsageEventContent,
} from "./usage-event.js";
import type { TelemetryWritePort } from "./write-port.js";

export type UsageEventInput = UsageEventContent & OutcomeReport;

export interface Recorder {
  record(input: UsageEventInput): void;
}

export class NodeUsageRecorder implements Recorder {
  private readonly sessionId: string;

  constructor(
    private readonly writePort: TelemetryWritePort,
    idGenerator: IdGenerator,
    private readonly stateDir: string,
  ) {
    this.sessionId = idGenerator.next();
  }

  record(input: UsageEventInput): void {
    try {
      this.writePort.ensureDir(this.stateDir);
      this.writePort.appendLine(
        usageLogPath(this.stateDir),
        JSON.stringify(this.buildUsageEvent(input)),
      );
    } catch {
      return;
    }
  }

  private buildUsageEvent(input: UsageEventInput): UsageEvent {
    const head = {
      schemaVersion: SCHEMA_VERSION,
      symnavVersion: input.symnavVersion,
      command: input.command,
      timestamp: input.timestamp,
      durationMs: input.durationMs,
    } satisfies Partial<UsageEvent>;
    const tail = {
      argShape: input.argShape,
      ...(input.resultCounts === undefined ? {} : { resultCounts: input.resultCounts }),
      workspaceId: input.workspaceId,
      machineId: input.machineId,
      sessionId: this.sessionId,
    } satisfies Partial<UsageEvent>;

    if (input.outcome === "success") {
      return { ...head, outcome: input.outcome, ...tail };
    }

    return { ...head, outcome: input.outcome, errorReason: input.errorReason, ...tail };
  }
}
