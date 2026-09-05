import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonActivitySnapshot,
  type DaemonPong,
} from "./daemon-protocol.js";
import type { DaemonResourceSnapshot } from "./daemon-resource-monitor.js";
import type { DaemonWorkerGenerationSnapshot } from "./daemon-worker-generation-manager.js";
import type { WorkspaceRequestQueueSnapshot } from "./workspace-request-queue.js";

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
    const recoveryDetail = DaemonActivityProjector.recoveryDetail(input);
    const current = DaemonActivityProjector.current(input, lifecycle);
    const activity: DaemonActivitySnapshot = Object.freeze({
      lifecycle,
      ...(recoveryDetail === undefined ? {} : { recoveryDetail }),
      pid: input.pid,
      startedAt: input.startedAt,
      startupElapsedMs: Math.max(0, input.nowMonotonicMs - input.startedMonotonicAt),
      ...(input.worker.ready && input.worker.fileCount !== undefined
        ? { fileCount: input.worker.fileCount }
        : {}),
      processRssBytes: input.processRssBytes,
      hardProcessRssBytes: input.hardProcessRssBytes,
      ...(input.resources.workerHeapUsedBytes === undefined
        ? {}
        : { workerHeapUsedBytes: input.resources.workerHeapUsedBytes }),
      workerGeneration: input.worker.generation,
      ...(current === undefined ? {} : { current }),
      queued: input.queue.queued,
      ...(input.lastCompletedMonotonicAt === undefined
        ? {}
        : {
            lastCompletedAgoMs: Math.max(0, input.nowMonotonicMs - input.lastCompletedMonotonicAt),
          }),
      spoolBytes: input.resources.spoolBytes,
    });
    const pong: DaemonPong = Object.freeze({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: input.instanceId,
      symnavVersion: input.productVersion,
      state: DaemonActivityProjector.legacyState(lifecycle),
      startedAt: input.startedAt,
      ...(input.worker.fileCount === undefined ? {} : { fileCount: input.worker.fileCount }),
      memoryBytes: input.processRssBytes,
      queued: input.queue.queued,
      activity,
      ...(current === undefined
        ? {}
        : {
            currentCommand: current.command,
            currentCommandElapsedMs: current.elapsedMs,
          }),
      ...(input.lastNavigationAt === undefined ? {} : { lastNavigationAt: input.lastNavigationAt }),
    });
    return Object.freeze({ activity, pong });
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

  private static recoveryDetail(
    input: DaemonActivityProjectionInput,
  ): DaemonActivitySnapshot["recoveryDetail"] {
    if (input.resources.state === "replacing") return "worker-replacement";
    if (input.resources.state === "shedding") return "resource-pressure";
    return undefined;
  }

  private static current(
    input: DaemonActivityProjectionInput,
    lifecycle: DaemonActivitySnapshot["lifecycle"],
  ): DaemonActivitySnapshot["current"] {
    if (lifecycle !== "busy" || input.queue.active === undefined) return undefined;
    return Object.freeze({
      requestId: input.queue.active.requestId,
      command: input.queue.active.command,
      elapsedMs: Math.max(0, input.nowMonotonicMs - input.queue.active.startedAt),
    });
  }

  private static legacyState(
    lifecycle: DaemonActivitySnapshot["lifecycle"],
  ): NonNullable<DaemonPong["state"]> {
    if (lifecycle === "busy") return "busy";
    if (lifecycle === "starting") return "starting";
    return "ready";
  }
}
