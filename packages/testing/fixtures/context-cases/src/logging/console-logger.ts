import type { Logger } from "./logger.js";
import { stamp } from "./stamp.js";

export class ConsoleLogger implements Logger {
  log(message: string): string {
    return stamp(message);
  }
}
