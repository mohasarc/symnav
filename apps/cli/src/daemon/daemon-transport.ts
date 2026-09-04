import type { DaemonExecutionFailureCode } from "@symnav/daemon";
import type {
  DaemonExecuteRequest,
  DaemonExecutionStatus,
  DaemonExecutionStatusRequest,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonRequest,
  DaemonResponse,
  DaemonServer,
  DaemonServerMessage,
} from "./daemon-protocol.js";
import type { LocalDaemonExecutionResult } from "./local-daemon-output.js";

export interface DaemonSocketConnection {
  readonly incoming: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): void;
  disableTimeout(): void;
  end(): void;
  destroy(): void;
}

export interface DaemonSocketClient {
  connect(endpoint: string, timeoutMs?: number): Promise<DaemonSocketConnection>;
}

export interface DaemonLifecycleRequestSender {
  request(endpoint: string, request: DaemonLifecycleRequest): Promise<DaemonResponse>;
}

export interface DaemonLifecycleRequester extends DaemonLifecycleRequestSender {
  request(endpoint: string, request: DaemonLifecycleRequest): Promise<DaemonLifecycleResponse>;
  executionStatus(
    endpoint: string,
    request: DaemonExecutionStatusRequest,
  ): Promise<DaemonExecutionStatus>;
}

export interface DaemonExecutionAcceptance {
  readonly requestId: string;
  readonly instanceId: string;
  readonly acceptedAt: number;
  readonly queuePosition: number;
}

export interface DaemonExecutionReceipt {
  readonly acceptance: DaemonExecutionAcceptance;
  readonly completion: Promise<
    | { readonly status: "completed"; readonly result: LocalDaemonExecutionResult }
    | { readonly status: "failed"; readonly code: DaemonExecutionFailureCode }
  >;
}

export interface DaemonExecutionRequester {
  execute(endpoint: string, request: DaemonExecuteRequest): Promise<DaemonExecutionReceipt>;
}

export type DaemonRequestHandler = (
  request: DaemonRequest,
  send: DaemonServerSend,
) => Promise<DaemonResponse | void>;

export interface DaemonRequestServer {
  listen(endpoint: string, handler: DaemonRequestHandler): Promise<DaemonServer>;
  removeUnavailableEndpoint(endpoint: string): Promise<boolean>;
}

export interface DaemonServerSend {
  (message: DaemonServerMessage): Promise<void>;
  onClose(listener: () => void): () => void;
}
