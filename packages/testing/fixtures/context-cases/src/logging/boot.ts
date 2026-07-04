import { ConsoleLogger } from "./console-logger.js";
import type { Logger } from "./logger.js";

export function bootWithLogger(logger: Logger): string {
  return logger.log("boot");
}

export function bootDefault(): string {
  return new ConsoleLogger().log("default");
}
