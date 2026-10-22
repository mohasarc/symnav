import { isAbsolute } from "node:path";
import type { DaemonFailure, DaemonFailureEvent } from "../daemon-failure.js";

export class DaemonFailureValues {
  private static readonly phases = new Set([
    "state location",
    "endpoint create",
    "endpoint bind",
    "endpoint connect",
    "process spawn",
    "warm-up",
    "worker",
    "transfer",
  ]);
  private static readonly reasons = new Set([
    "state-write-failed",
    "endpoint-create-failed",
    "endpoint-bind-denied",
    "endpoint-connect-failed",
    "daemon-connection-reset",
    "process-spawn-failed",
    "startup-failed",
    "worker-failed",
    "transfer-failed",
    "process-terminated",
    "daemon-incompatible",
  ]);

  public static isFailure(value: unknown): value is DaemonFailure {
    if (!this.isObject(value)) return false;
    return (
      this.exactKeys(value, ["phase", "reason", "timestamp"], ["osCode"]) &&
      typeof value.phase === "string" &&
      this.phases.has(value.phase) &&
      typeof value.reason === "string" &&
      this.reasons.has(value.reason) &&
      typeof value.timestamp === "number" &&
      Number.isFinite(value.timestamp) &&
      value.timestamp >= 0 &&
      (value.osCode === undefined || this.isOsCode(value.osCode))
    );
  }

  public static isEvent(value: unknown): value is DaemonFailureEvent {
    if (!this.isObject(value)) return false;
    return (
      this.exactKeys(
        value,
        ["schemaVersion", "eventId", "workspaceRoot", "kind", "failure"],
        ["instanceId", "requestId"],
      ) &&
      value.schemaVersion === 1 &&
      this.isCorrelation(value.eventId) &&
      typeof value.workspaceRoot === "string" &&
      isAbsolute(value.workspaceRoot) &&
      typeof value.kind === "string" &&
      ["startup-failure", "fallback", "termination"].includes(value.kind) &&
      this.isFailure(value.failure) &&
      (value.instanceId === undefined || this.isCorrelation(value.instanceId)) &&
      (value.requestId === undefined || this.isCorrelation(value.requestId))
    );
  }

  private static isOsCode(value: unknown): value is string {
    return typeof value === "string" && /^(?:E[A-Z0-9_]{1,63}|ERR_[A-Z0-9_]{1,60})$/u.test(value);
  }

  private static isCorrelation(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9:._-]{1,256}$/u.test(value);
  }

  private static isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static exactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
  ): boolean {
    return (
      required.every((key) => key in value) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    );
  }
}
