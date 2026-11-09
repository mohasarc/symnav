import { appendFileSync } from "node:fs";

export class DiagLaps {
  static mark(scope: string, label: string): void {
    const file = process.env.SYMNAV_DIAG_LAPS;
    if (file === undefined || file === "") return;
    try {
      appendFileSync(file, `${Date.now()} ${process.pid} ${scope} ${label}\n`);
    } catch {}
  }
}
