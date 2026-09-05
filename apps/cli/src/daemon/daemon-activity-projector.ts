import type { DaemonActivitySnapshot, DaemonPong } from "./daemon-protocol.js";
import type { DaemonResourceSnapshot } from "./daemon-resource-monitor.js";
import type { WorkspaceRequestQueueSnapshot } from "./workspace-request-queue.js";

export interface DaemonWorkerGenerationSnapshot {
  readonly generation: number;
  readonly ready: boolean;
  readonly fileCount?: number;
}

export interface DaemonActivityProjectionInput {
  readonly nowMonotonicMs: number;
  readonly pid: number;
  readonly processRssBytes: number;
  readonly startedAt: number;
  readonly startedMonotonicAt: number;
  readonly lastNavigationAt?: number;
  readonly lastCompletedMonotonicAt?: number;
  readonly productVersion: string;
  readonly instanceId: string;
  readonly hardProcessRssBytes: number;
  readonly queue: WorkspaceRequestQueueSnapshot;
  readonly resources: DaemonResourceSnapshot;
  readonly worker: DaemonWorkerGenerationSnapshot;
}

export interface DaemonActivityProjection {
  readonly activity: DaemonActivitySnapshot;
  readonly pong: DaemonPong;
}
