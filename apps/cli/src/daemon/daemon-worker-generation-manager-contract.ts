import type { DaemonCommandName, DaemonExecutorRequest } from "@symnav/daemon";
import type {
  DaemonNavigationWorker,
  DaemonNavigationWorkerExit,
} from "./daemon-navigation-worker.js";
import type { DaemonNavigationWorkerResponse } from "./daemon-navigation-worker-protocol.js";
import type { DaemonWorkerDiagnostic, DaemonWorkerReplacementCause } from "./daemon-protocol.js";

export type DaemonWorkerReadyReport = Extract<
  DaemonNavigationWorkerResponse,
  { readonly kind: "ready" }
>;

export type DaemonWorkerExecutionReport = Extract<
  DaemonNavigationWorkerResponse,
  { readonly kind: "result" }
>;

export type DaemonWorkerResourceReport = Extract<
  DaemonNavigationWorkerResponse,
  { readonly kind: "heap" }
>;

export interface DaemonWorkerExecuteRequest {
  readonly commandName: DaemonCommandName;
  readonly request: DaemonExecutorRequest;
}

export interface DaemonWorkerGenerationSnapshot {
  readonly generation: number;
  readonly ready: boolean;
  readonly fileCount?: number;
}

export interface DaemonWorkerExitRecovery {
  recover(exit: DaemonNavigationWorkerExit): Promise<void>;
}

export interface DaemonWorkerGenerationManagerOptions {
  readonly workspaceRoot: string;
  readonly createWorker: (generation: number) => DaemonNavigationWorker;
  readonly initialWorker?: DaemonNavigationWorker;
  readonly exitRecovery: DaemonWorkerExitRecovery;
  readonly onActiveResourceInterruption: (cause: DaemonWorkerReplacementCause) => void;
  readonly onDiagnostic: (diagnostic: DaemonWorkerDiagnostic) => void;
}
