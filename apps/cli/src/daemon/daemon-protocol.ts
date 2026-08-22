import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_RECORD_SCHEMA_VERSION = 1;

export interface DaemonRecord {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly symnavVersion: string;
  readonly workspaceRoot: string;
  readonly workspaceKey: string;
  readonly instanceId: string;
  readonly processToken: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly state: "starting" | "ready";
  readonly startedAt: number;
  readonly readyAt?: number;
  readonly lastNavigationAt?: number;
  readonly fileCount?: number;
  readonly memoryBytes?: number;
  readonly memoryCapBytes: number;
}

export type WorkspaceRequestQueueState = "accepting" | "draining" | "closed";

export interface RunningDaemonStatus {
  readonly workspaceRoot: string;
  readonly state: "starting" | "ready";
  readonly pid: number;
  readonly uptimeMs: number;
  readonly fileCount?: number;
  readonly memoryBytes?: number;
  readonly lastRequestAgoMs?: number;
}

export type DaemonStopResult =
  | { readonly status: "stopped"; readonly workspaceRoot: string; readonly pid: number }
  | { readonly status: "killed"; readonly workspaceRoot: string; readonly pid: number }
  | { readonly status: "not-running"; readonly workspaceRoot: string };

export type DaemonStopReason = "graceful" | "idle" | "resource" | "workspace-deleted";

export type DaemonLogEvent =
  | { readonly kind: "start"; readonly workspaceRoot: string; readonly instanceId: string }
  | { readonly kind: "ready"; readonly fileCount: number }
  | {
      readonly kind: "request";
      readonly command: string;
      readonly durationMs: number;
      readonly exitCode: number;
    }
  | {
      readonly kind: "freshness";
      readonly added: number;
      readonly changed: number;
      readonly removed: number;
      readonly unchanged: number;
    }
  | { readonly kind: "stop"; readonly reason: DaemonStopReason }
  | { readonly kind: "failure"; readonly operation: string; readonly message: string };

export type DaemonRequest =
  | {
      readonly kind: "identify";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "terminate";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "kill";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | { readonly kind: "ping"; readonly protocolVersion: number; readonly instanceId: string }
  | {
      readonly kind: "execute";
      readonly protocolVersion: number;
      readonly instanceId: string;
      readonly requestId: string;
      readonly request: CliExecutionRequest;
    }
  | { readonly kind: "stop"; readonly protocolVersion: number; readonly instanceId: string };

export type DaemonResponse =
  | {
      readonly kind: "identity";
      readonly instanceId: string;
      readonly processToken: string;
      readonly pid: number;
      readonly startedAt: number;
    }
  | {
      readonly kind: "terminating";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "killing";
      readonly instanceId: string;
      readonly processToken: string;
    }
  | {
      readonly kind: "pong";
      readonly protocolVersion: number;
      readonly instanceId: string;
      readonly symnavVersion: string;
      readonly startedAt?: number;
      readonly fileCount?: number;
      readonly memoryBytes?: number;
      readonly lastNavigationAt?: number;
    }
  | { readonly kind: "result"; readonly requestId: string; readonly result: CommandExecutionResult }
  | { readonly kind: "stopped"; readonly instanceId: string };

export interface DaemonServer {
  close(): Promise<void>;
}

export type DaemonStartResult =
  | {
      readonly status: "ready";
      readonly workspaceRoot: string;
      readonly fileCount: number;
      readonly loadDurationMs: number;
    }
  | {
      readonly status: "already-running";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
    }
  | { readonly status: "disabled" };
