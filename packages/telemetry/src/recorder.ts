import type { IdGenerator } from "./id-generator.js";
import { usageLogPath } from "./state-dir.js";
import { SCHEMA_VERSION, type ArgShape, type Outcome, type UsageEvent } from "./usage-event.js";
import type { TelemetryWritePort } from "./write-port.js";

export interface UsageEventInput {
  readonly symnavVersion: string;
  readonly command: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly errorReason?: string;
  readonly argShape: ArgShape;
  readonly resultCounts?: Readonly<Record<string, number>>;
  readonly workspaceId: string;
  readonly machineId: string;
}

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
    return {
      schemaVersion: SCHEMA_VERSION,
      symnavVersion: input.symnavVersion,
      command: input.command,
      timestamp: input.timestamp,
      durationMs: input.durationMs,
      outcome: input.outcome,
      ...(input.errorReason === undefined ? {} : { errorReason: input.errorReason }),
      argShape: input.argShape,
      ...(input.resultCounts === undefined ? {} : { resultCounts: input.resultCounts }),
      workspaceId: input.workspaceId,
      machineId: input.machineId,
      sessionId: this.sessionId,
    };
  }
}
