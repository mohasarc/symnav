import { appendFileSync, mkdirSync } from "node:fs";

export interface TelemetryWritePort {
  ensureDir(dir: string): void;
  appendLine(filePath: string, line: string): void;
}

export class NodeTelemetryWritePort implements TelemetryWritePort {
  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  }

  appendLine(filePath: string, line: string): void {
    appendFileSync(filePath, `${line}\n`, "utf8");
  }
}
