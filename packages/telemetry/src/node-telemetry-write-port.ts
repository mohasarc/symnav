import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryWritePort } from "./write-port.js";
import type { TelemetryFailureObserver } from "./write-failure.js";

export class NodeTelemetryWritePort implements TelemetryWritePort {
  private disabled = false;

  constructor(
    private readonly usageLogPath: string,
    private readonly observer?: TelemetryFailureObserver,
  ) {}

  append(line: string): void {
    if (this.disabled) return;
    try {
      mkdirSync(dirname(this.usageLogPath), { recursive: true });
      appendFileSync(this.usageLogPath, `${line}\n`, "utf8");
    } catch (error) {
      this.disabled = true;
      const osCode = (error as NodeJS.ErrnoException).code;
      this.observer?.writeFailed({
        path: this.usageLogPath,
        ...(osCode === undefined ? {} : { osCode }),
      });
      throw error;
    }
  }
}
