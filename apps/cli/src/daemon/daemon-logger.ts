import { appendFileSync } from "node:fs";
import type { Clock } from "@symnav/telemetry";
import type { DaemonLogEvent } from "./daemon-protocol.js";

export class DaemonLogger {
  constructor(
    private readonly logPath: string,
    private readonly clock: Clock,
  ) {}

  record(event: DaemonLogEvent): void {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ timestamp: this.clock.now(), ...event })}\n`,
      { encoding: "utf8", flag: "a", mode: 0o600 },
    );
  }
}
