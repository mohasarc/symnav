import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonActivitySnapshot,
  type DaemonPong,
} from "./daemon-protocol.js";
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

export class DaemonActivityProjector {
  static project(input: DaemonActivityProjectionInput): DaemonActivityProjection {
    const lifecycle = DaemonActivityProjector.lifecycle(input);
    const activity: DaemonActivitySnapshot = {
      lifecycle,
      pid: input.pid,
      startedAt: input.startedAt,
      startupElapsedMs: Math.max(0, input.nowMonotonicMs - input.startedMonotonicAt),
      processRssBytes: input.processRssBytes,
      hardProcessRssBytes: input.hardProcessRssBytes,
      workerGeneration: input.resources.generation,
      queued: input.queue.queued,
      spoolBytes: 0,
    };
    const pong: DaemonPong = {
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: input.instanceId,
      symnavVersion: input.productVersion,
      state: DaemonActivityProjector.legacyState(lifecycle),
      startedAt: input.startedAt,
      memoryBytes: input.processRssBytes,
      queued: input.queue.queued,
      activity,
    };
    return { activity, pong };
  }

  private static lifecycle(
    input: DaemonActivityProjectionInput,
  ): DaemonActivitySnapshot["lifecycle"] {
    if (
      input.queue.state !== "accepting" ||
      input.resources.state === "draining" ||
      input.resources.state === "stopped"
    ) {
      return "draining";
    }
    if (input.resources.state === "replacing" || input.resources.state === "shedding") {
      return "recovering";
    }
    if (!input.worker.ready) return "starting";
    return input.queue.active === undefined ? "ready" : "busy";
  }

  private static legacyState(
    lifecycle: DaemonActivitySnapshot["lifecycle"],
  ): NonNullable<DaemonPong["state"]> {
    if (lifecycle === "busy") return "busy";
    if (lifecycle === "starting") return "starting";
    return "ready";
  }
}
