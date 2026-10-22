import type { DaemonCommandName } from "./daemon-command-name.js";

export interface DaemonActivitySnapshot {
  readonly lifecycle: "starting" | "ready" | "busy" | "recovering" | "draining";
  readonly recoveryDetail?: "resource-pressure" | "worker-replacement";
  readonly pid: number;
  readonly startedAt: number;
  readonly startupElapsedMs: number;
  readonly fileCount?: number;
  readonly processRssBytes: number;
  readonly hardProcessRssBytes: number;
  readonly workerHeapUsedBytes?: number;
  readonly workerGeneration: number;
  readonly current?: {
    readonly requestId: string;
    readonly command: DaemonCommandName;
    readonly elapsedMs: number;
  };
  readonly queued: number;
  readonly lastCompletedAgoMs?: number;
  readonly spoolBytes: number;
}

export type RunningDaemonStatus =
  | {
      readonly state: "starting";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly startupElapsedMs: number;
      readonly memoryBytes?: number;
    }
  | {
      readonly state: "ready";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly fileCount: number;
      readonly memoryBytes: number;
      readonly lastRequestAgoMs?: number;
    }
  | {
      readonly state: "busy";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly command: DaemonCommandName;
      readonly elapsedMs: number;
      readonly queued: number;
      readonly memoryBytes: number;
    }
  | {
      readonly state: "recovering";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly detail: "resource-pressure" | "worker-replacement" | "draining";
      readonly queued: number;
      readonly memoryBytes: number;
    }
  | {
      readonly state: "unresponsive";
      readonly workspaceRoot: string;
      readonly pid: number;
      readonly uptimeMs: number;
      readonly lastResponseAgoMs?: number;
      readonly lastKnown?: DaemonActivitySnapshot;
    };

export interface DaemonStatusEnvelope {
  readonly schemaVersion: 1;
  readonly daemons: readonly RunningDaemonStatus[];
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

export type DaemonStopResult =
  | { readonly status: "stopped"; readonly workspaceRoot: string; readonly pid: number }
  | { readonly status: "killed"; readonly workspaceRoot: string; readonly pid: number }
  | { readonly status: "not-running"; readonly workspaceRoot: string };
