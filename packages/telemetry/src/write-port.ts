import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TelemetryWritePort {
  append(line: string): void;
}

export class NodeTelemetryWritePort implements TelemetryWritePort {
  constructor(private readonly usageLogPath: string) {}

  append(line: string): void {
    mkdirSync(dirname(this.usageLogPath), { recursive: true });
    appendFileSync(this.usageLogPath, `${line}\n`, "utf8");
  }
}
