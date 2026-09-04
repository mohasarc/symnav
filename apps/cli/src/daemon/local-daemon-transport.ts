import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  DaemonAdmissionRejections,
  DaemonExecutionFailures,
  type DaemonExecuteRejectionCode,
  type DaemonExecutionFailureCode,
  type DaemonPolicyValues,
  type DaemonRejectedExecutionFrame,
} from "@symnav/daemon";
import type {
  DaemonExecuteRequest,
  DaemonExecutionServerFrame,
  DaemonExecutionStatus,
  DaemonExecutionStatusRequest,
  DaemonExecutionStatusResponse,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonResultAcknowledgement,
  DaemonResultChunk,
  DaemonRequest,
  DaemonResponse,
  DaemonServerMessage,
  DaemonServer,
} from "./daemon-protocol.js";
import type {
  DaemonExecutionAcceptance,
  DaemonExecutionReceipt,
  DaemonExecutionRequester,
  DaemonLifecycleRequester,
  DaemonRequestHandler,
  DaemonRequestServer,
  DaemonServerSend,
} from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { DaemonRuntimeValues } from "./daemon-runtime-values.js";
import type { CompletionSpoolManifest } from "./completion-spool.js";
import { LocalDaemonOutput, type LocalDaemonExecutionResult } from "./local-daemon-output.js";

interface LocalDaemonTransportOptions {
  readonly responseTimeoutPurpose?: "ordinary" | "status-observer";
  readonly writeChunkSize?: number;
  readonly outputDirectory?: string;
}

export type LocalDaemonTransportPolicy = Pick<
  DaemonPolicyValues,
  "transport" | "delivery" | "output"
>;

export type DaemonDeliveryState = "not-submitted" | "submitted-unconfirmed" | "accepted";

export type DaemonTransportFailureCode =
  | "unreachable"
  | "timeout"
  | "corrupt"
  | "incompatible"
  | "authentication"
  | "closed"
  | "rejected";

export class DaemonTransportError extends Error {
  readonly authenticatedInstanceId?: string;
  readonly retrySafe: boolean;

  constructor(
    readonly code: DaemonTransportFailureCode,
    readonly delivery: DaemonDeliveryState,
    message: string,
    authenticatedInstanceId?: string,
    authenticatedRejectionCode?: DaemonExecuteRejectionCode,
  ) {
    super(message);
    this.name = "DaemonTransportError";
    if (authenticatedInstanceId !== undefined) {
      this.authenticatedInstanceId = authenticatedInstanceId;
    }
    this.retrySafe =
      delivery === "not-submitted" ||
      (code === "rejected" &&
        delivery === "submitted-unconfirmed" &&
        authenticatedInstanceId !== undefined &&
        authenticatedRejectionCode !== undefined &&
        DaemonAdmissionRejections.retrySafe(authenticatedRejectionCode));
  }
}

class DaemonResponseError extends Error {
  constructor(
    readonly code: Extract<
      DaemonTransportFailureCode,
      "authentication" | "corrupt" | "incompatible"
    >,
    message: string,
    readonly authenticatedInstanceId?: string,
  ) {
    super(message);
  }
}

class DaemonResultTransferReceiver {
  private expectedManifest: CompletionSpoolManifest | undefined;
  private nextRecordOffset: number;
  private manifestReceived = false;
  private terminalReceived = false;

  constructor(
    private readonly request: DaemonExecuteRequest,
    private readonly output: LocalDaemonOutput,
    manifest?: CompletionSpoolManifest,
    initialOffset = 0,
  ) {
    this.expectedManifest = manifest;
    this.nextRecordOffset = initialOffset;
  }

  get manifest(): CompletionSpoolManifest | undefined {
    return this.expectedManifest;
  }

  get nextOffset(): number {
    return this.nextRecordOffset;
  }

  get terminal(): boolean {
    return this.terminalReceived;
  }

  beginConnection(): void {
    this.manifestReceived = false;
    this.terminalReceived = false;
  }

  acceptManifest(
    frame: Extract<DaemonExecutionServerFrame, { readonly kind: "result-manifest" }>,
  ): void {
    if (this.manifestReceived || this.terminalReceived) {
      throw new Error("Duplicate result manifest");
    }
    if (
      this.expectedManifest !== undefined &&
      !DaemonResultTransferReceiver.manifestsMatch(this.expectedManifest, frame.manifest)
    ) {
      throw new Error("Daemon resumed with a different result manifest");
    }
    this.expectedManifest ??= frame.manifest;
    this.manifestReceived = true;
  }

  async acceptChunk(chunk: DaemonResultChunk): Promise<void> {
    const manifest = this.expectedManifest;
    if (
      !this.manifestReceived ||
      this.terminalReceived ||
      manifest === undefined ||
      chunk.requestId !== this.request.requestId ||
      chunk.transferId !== manifest.transferId ||
      chunk.offset !== this.nextRecordOffset ||
      chunk.sequence !== this.nextRecordOffset
    ) {
      throw new Error("Daemon returned an invalid result chunk");
    }
    await this.output.appendRecord({
      sequence: chunk.sequence,
      stream: chunk.stream,
      bytes: chunk.bytes,
    });
    this.nextRecordOffset += 1;
  }

  acceptEnd(frame: Extract<DaemonExecutionServerFrame, { readonly kind: "result-end" }>): void {
    const manifest = this.expectedManifest;
    if (
      !this.manifestReceived ||
      this.terminalReceived ||
      manifest === undefined ||
      frame.transferId !== manifest.transferId ||
      frame.rawBytes !== manifest.rawBytes ||
      frame.recordCount !== manifest.recordCount ||
      frame.sha256 !== manifest.sha256 ||
      this.nextRecordOffset !== manifest.recordCount
    ) {
      throw new Error("Daemon result transfer did not match its manifest");
    }
    this.terminalReceived = true;
  }

  async finish(): Promise<LocalDaemonExecutionResult> {
    const manifest = this.expectedManifest;
    if (!this.terminalReceived || manifest === undefined) {
      throw new Error("Daemon result transfer is incomplete");
    }
    const result = await this.output.finish(manifest.exitCode);
    if (!DaemonResultTransferReceiver.summariesMatch(result.output.summary, manifest)) {
      await result.output.dispose();
      throw new Error("Daemon result transfer failed digest validation");
    }
    return result;
  }

  private static manifestsMatch(
    expected: CompletionSpoolManifest,
    actual: CompletionSpoolManifest,
  ): boolean {
    return (
      actual.transferId === expected.transferId &&
      actual.requestId === expected.requestId &&
      actual.instanceId === expected.instanceId &&
      actual.exitCode === expected.exitCode &&
      DaemonResultTransferReceiver.summariesMatch(actual, expected)
    );
  }

  private static summariesMatch(
    actual: CompletionSpoolManifest | LocalDaemonExecutionResult["output"]["summary"],
    expected: CompletionSpoolManifest,
  ): boolean {
    return (
      actual.rawBytes === expected.rawBytes &&
      actual.recordCount === expected.recordCount &&
      actual.sha256 === expected.sha256
    );
  }
}

class ListeningDaemonServer implements DaemonServer {
  constructor(
    private readonly server: Server,
    private readonly sockets: ReadonlySet<Socket>,
  ) {}

  close(force = false): Promise<void> {
    if (force) {
      for (const socket of this.sockets) socket.destroy();
    }
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export class LocalDaemonTransport
  implements DaemonLifecycleRequester, DaemonExecutionRequester, DaemonRequestServer
{
  private readonly requestTimeoutMs: number;
  private readonly executionRequestTimeoutMs: number;
  private readonly writeChunkSize: number | undefined;
  private readonly outputDirectory: string | undefined;
  private readonly codec: DaemonWireCodec;
  private readonly outputPolicy: DaemonPolicyValues["output"];
  private readonly deliveryPolicy: DaemonPolicyValues["delivery"];

  constructor(policy: LocalDaemonTransportPolicy, options: LocalDaemonTransportOptions = {}) {
    this.requestTimeoutMs =
      options.responseTimeoutPurpose === "status-observer"
        ? policy.transport.statusResponseTimeoutMs
        : policy.transport.singleResponseTimeoutMs;
    this.executionRequestTimeoutMs = policy.transport.executionAdmissionTimeoutMs;
    this.codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes: policy.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
    });
    this.outputPolicy = policy.output;
    this.deliveryPolicy = policy.delivery;
    this.writeChunkSize = options.writeChunkSize;
    this.outputDirectory = options.outputDirectory;
  }

  canFrame(value: unknown): boolean {
    try {
      this.codec.encodeControl(value);
      return true;
    } catch {
      return false;
    }
  }

  request(endpoint: string, request: DaemonLifecycleRequest): Promise<DaemonLifecycleResponse> {
    return this.singleResponse(endpoint, request);
  }

  private singleResponse(
    endpoint: string,
    request: DaemonLifecycleRequest,
  ): Promise<DaemonLifecycleResponse>;
  private singleResponse(
    endpoint: string,
    request: DaemonExecutionStatusRequest,
  ): Promise<DaemonExecutionStatusResponse>;
  private singleResponse(
    endpoint: string,
    request: DaemonLifecycleRequest | DaemonExecutionStatusRequest,
  ): Promise<DaemonLifecycleResponse | DaemonExecutionStatusResponse> {
    LocalDaemonTransport.assertRequest(request);
    return new Promise((resolve, reject) => {
      const decoder = this.codec.controlDecoder();
      const socket = createConnection(endpoint);
      let settled = false;
      let delivery: DaemonDeliveryState = "not-submitted";
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(LocalDaemonTransport.transportError(error, delivery));
      };
      socket.setTimeout(this.requestTimeoutMs, () =>
        fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out")),
      );
      socket.once("error", (error) => {
        if (delivery === "not-submitted") {
          fail(new DaemonTransportError("unreachable", delivery, error.message));
          return;
        }
        fail(new DaemonTransportError("closed", delivery, error.message));
      });
      socket.once("connect", () => {
        try {
          this.writeFrame(socket, request);
          delivery = "submitted-unconfirmed";
        } catch (error) {
          fail(error);
        }
      });
      socket.on("data", (bytes) => {
        try {
          const values = decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
          if (values.length > 1 || (values.length === 1 && settled)) {
            fail(new Error("Daemon returned multiple responses"));
            return;
          }
          const value = values[0];
          if (value === undefined) return;
          const response = LocalDaemonTransport.responseFor(request, value);
          delivery = "accepted";
          settled = true;
          socket.end();
          resolve(response);
        } catch (error) {
          fail(error);
        }
      });
      socket.once("end", () => {
        if (settled) return;
        try {
          decoder.assertComplete();
          fail(
            new DaemonTransportError(
              "closed",
              delivery,
              "Daemon connection ended before a response",
            ),
          );
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  execute(endpoint: string, request: DaemonExecuteRequest): Promise<DaemonExecutionReceipt> {
    return this.executeOnce(endpoint, request).then((receipt) => ({
      acceptance: receipt.acceptance,
      completion: this.completeWithReattachments(endpoint, request, receipt.completion),
    }));
  }

  private async completeWithReattachments(
    endpoint: string,
    request: DaemonExecuteRequest,
    completion: DaemonExecutionReceipt["completion"],
  ): DaemonExecutionReceipt["completion"] {
    let currentCompletion = completion;
    let reattachmentCount = 0;
    while (true) {
      try {
        return await currentCompletion;
      } catch (firstError) {
        if (
          !LocalDaemonTransport.isAcceptedConnectionClose(firstError, request) ||
          reattachmentCount >= this.deliveryPolicy.postAcceptanceExecutionReattachmentLimit
        ) {
          throw firstError;
        }
        try {
          const reattached = await this.executeOnce(endpoint, request);
          currentCompletion = reattached.completion;
          reattachmentCount += 1;
        } catch {
          throw firstError;
        }
      }
    }
  }

  private executeOnce(
    endpoint: string,
    request: DaemonExecuteRequest,
  ): Promise<DaemonExecutionReceipt> {
    LocalDaemonTransport.assertRequest(request);
    return new Promise((resolve, reject) => {
      const decoder = this.codec.transferDecoder();
      const output = new LocalDaemonOutput({
        policy: this.outputPolicy,
        ...(this.outputDirectory === undefined ? {} : { directory: this.outputDirectory }),
      });
      const transfer = new DaemonResultTransferReceiver(request, output);
      const socket = createConnection(endpoint);
      let delivery: DaemonDeliveryState = "not-submitted";
      let acceptance: DaemonExecutionAcceptance | undefined;
      let terminal = false;
      let outerSettled = false;
      let completionSettled = false;
      let resumeCount = 0;
      let resolveCompletion!: (value: Awaited<DaemonExecutionReceipt["completion"]>) => void;
      let rejectCompletion!: (error: DaemonTransportError) => void;
      const completion = new Promise<Awaited<DaemonExecutionReceipt["completion"]>>(
        (completionResolve, completionReject) => {
          resolveCompletion = completionResolve;
          rejectCompletion = completionReject;
        },
      );
      let consumption = Promise.resolve();
      const fail = (error: unknown): void => {
        const transportError = LocalDaemonTransport.transportError(error, delivery);
        socket.destroy();
        if (!outerSettled) {
          outerSettled = true;
          void output.dispose().finally(() => reject(transportError));
          return;
        }
        if (!completionSettled) {
          completionSettled = true;
          void output.dispose().finally(() => rejectCompletion(transportError));
        }
      };
      const resume = (): boolean => {
        if (
          resumeCount >= this.deliveryPolicy.resultTransferResumeLimitPerExecutionAttempt ||
          completionSettled ||
          acceptance === undefined ||
          transfer.manifest === undefined ||
          terminal
        ) {
          return false;
        }
        resumeCount += 1;
        socket.destroy();
        transfer.beginConnection();
        void this.fetchCompletion(endpoint, request, output, transfer)
          .then((completionValue) => {
            if (completionSettled) return;
            completionSettled = true;
            resolveCompletion(completionValue);
          })
          .catch(fail);
        return true;
      };
      socket.setTimeout(this.executionRequestTimeoutMs, () =>
        fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out")),
      );
      socket.once("error", (error) => {
        void consumption
          .then(() => {
            if (resume()) return;
            fail(
              new DaemonTransportError(
                delivery === "not-submitted" ? "unreachable" : "closed",
                delivery,
                error.message,
                acceptance?.instanceId,
              ),
            );
          })
          .catch(fail);
      });
      socket.once("connect", () => {
        try {
          const encoded = this.codec.encodeControl(request);
          delivery = "submitted-unconfirmed";
          this.writeEncodedFrame(socket, encoded);
        } catch (error) {
          fail(error);
        }
      });
      const publishAcceptance = (): void => {
        if (acceptance === undefined || outerSettled) return;
        outerSettled = true;
        socket.setTimeout(0);
        resolve({ acceptance, completion });
      };
      const consume = async (bytes: Buffer): Promise<void> => {
        const values = decoder.append(bytes);
        let completedResult = false;
        let failedCode: DaemonExecutionFailureCode | undefined;
        for (const value of values) {
          if (LocalDaemonTransport.isResultChunk(value)) {
            if (acceptance === undefined)
              throw new Error("Daemon returned output before acceptance");
            await transfer.acceptChunk(value);
            continue;
          }
          const frame = LocalDaemonTransport.executionFrameFor(request, value);
          if (frame.kind === "rejected") {
            if (acceptance !== undefined || terminal) {
              throw new Error("Daemon rejected an already accepted request");
            }
            throw new DaemonTransportError(
              "rejected",
              "submitted-unconfirmed",
              `Daemon rejected execution: ${frame.code}`,
              frame.instanceId,
              frame.code,
            );
          }
          if (frame.kind === "accepted") {
            if (acceptance !== undefined || terminal) {
              throw new Error("Daemon returned duplicate acceptance");
            }
            delivery = "accepted";
            acceptance = {
              requestId: frame.requestId,
              instanceId: frame.instanceId,
              acceptedAt: frame.acceptedAt,
              queuePosition: frame.queuePosition,
            };
            publishAcceptance();
            continue;
          }
          if (acceptance === undefined) {
            throw new Error("Daemon returned completion before acceptance");
          }
          if (frame.kind === "result-manifest") {
            if (terminal) throw new Error("Daemon returned a manifest after completion");
            transfer.acceptManifest(frame);
            continue;
          }
          if (frame.kind === "result-end") {
            transfer.acceptEnd(frame);
            terminal = true;
            completedResult = true;
            continue;
          }
          if (terminal) throw new Error("Daemon returned duplicate terminal frame");
          terminal = true;
          failedCode = frame.code;
        }
        if (completedResult) {
          const result = await transfer.finish();
          const completedManifest = transfer.manifest;
          if (completedManifest === undefined) throw new Error("Completion manifest is missing");
          await this.acknowledgeResult(endpoint, request, completedManifest);
          if (!completionSettled) {
            completionSettled = true;
            socket.end();
            resolveCompletion({ status: "completed", result });
          }
        }
        if (failedCode !== undefined && !completionSettled) {
          completionSettled = true;
          socket.end();
          await output.dispose();
          resolveCompletion({ status: "failed", code: failedCode });
        }
      };
      socket.on("data", (bytes) => {
        socket.pause();
        consumption = consumption
          .then(() => consume(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)))
          .then(() => {
            if (!socket.destroyed && !terminal) socket.resume();
          });
        void consumption.catch(fail);
      });
      socket.once("end", () => {
        void consumption
          .then(() => {
            if (terminal && completionSettled) return;
            if (resume()) return;
            decoder.assertComplete();
            fail(
              new DaemonTransportError(
                "closed",
                delivery,
                acceptance === undefined
                  ? "Daemon connection ended before acceptance"
                  : "Daemon connection ended after acceptance before completion",
                acceptance?.instanceId,
              ),
            );
          })
          .catch(fail);
      });
    });
  }

  private static isAcceptedConnectionClose(
    error: unknown,
    request: DaemonExecuteRequest,
  ): error is DaemonTransportError {
    return (
      error instanceof DaemonTransportError &&
      error.code === "closed" &&
      error.delivery === "accepted" &&
      error.authenticatedInstanceId === request.instanceId
    );
  }

  private fetchCompletion(
    endpoint: string,
    request: DaemonExecuteRequest,
    output: LocalDaemonOutput,
    transfer: DaemonResultTransferReceiver,
  ): DaemonExecutionReceipt["completion"] {
    return new Promise((resolve, reject) => {
      const decoder = this.codec.transferDecoder();
      const socket = createConnection(endpoint);
      let ended = false;
      let settled = false;
      let consumption = Promise.resolve();
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(LocalDaemonTransport.transportError(error, "accepted"));
      };
      socket.once("error", (error) => {
        void consumption
          .then(() =>
            fail(new DaemonTransportError("closed", "accepted", error.message, request.instanceId)),
          )
          .catch(fail);
      });
      socket.once("connect", () => {
        this.writeFrame(socket, {
          kind: "result-fetch",
          protocolVersion: request.protocolVersion,
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          offset: transfer.nextOffset,
        });
      });
      const consume = async (bytes: Buffer): Promise<void> => {
        let completedResult = false;
        let failedCode: DaemonExecutionFailureCode | undefined;
        for (const value of decoder.append(bytes)) {
          if (ended) throw new Error("Daemon resumed with a duplicate terminal frame");
          if (LocalDaemonTransport.isResultChunk(value)) {
            await transfer.acceptChunk(value);
            continue;
          }
          const frame = LocalDaemonTransport.executionFrameFor(request, value);
          if (frame.kind === "result-manifest") {
            transfer.acceptManifest(frame);
            continue;
          }
          if (frame.kind === "execution-failed") {
            ended = true;
            failedCode = frame.code;
            continue;
          }
          if (frame.kind !== "result-end") {
            throw new Error("Daemon resumed with an invalid terminal frame");
          }
          transfer.acceptEnd(frame);
          ended = true;
          completedResult = true;
        }
        if (completedResult) {
          const result = await transfer.finish();
          const manifest = transfer.manifest;
          if (manifest === undefined) throw new Error("Completion manifest is missing");
          await this.acknowledgeResult(endpoint, request, manifest);
          settled = true;
          socket.end();
          resolve({ status: "completed", result });
        }
        if (failedCode !== undefined) {
          settled = true;
          socket.end();
          await output.dispose();
          resolve({ status: "failed", code: failedCode });
        }
      };
      socket.on("data", (bytes) => {
        socket.pause();
        consumption = consumption
          .then(() => consume(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)))
          .then(() => {
            if (!socket.destroyed && !ended) socket.resume();
          });
        void consumption.catch(fail);
      });
      socket.once("end", () => {
        void consumption
          .then(() => {
            if (ended) return;
            decoder.assertComplete();
            fail(new Error("Daemon result resume ended before completion"));
          })
          .catch(fail);
      });
    });
  }

  private async acknowledgeResult(
    endpoint: string,
    request: DaemonExecuteRequest,
    manifest: Extract<DaemonExecutionServerFrame, { kind: "result-manifest" }>["manifest"],
  ): Promise<void> {
    const acknowledgement: DaemonResultAcknowledgement = {
      kind: "result-ack",
      protocolVersion: request.protocolVersion,
      instanceId: request.instanceId,
      processToken: request.processToken,
      requestId: request.requestId,
      transferId: manifest.transferId,
    };
    await new Promise<void>((resolve, reject) => {
      const decoder = this.codec.controlDecoder();
      const socket = createConnection(endpoint);
      let responseReceived = false;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve();
      };
      const complete = (): void => {
        try {
          decoder.assertComplete();
          if (!responseReceived) throw new Error("Daemon acknowledgement response is missing");
          succeed();
        } catch (error) {
          fail(error);
        }
      };
      socket.setTimeout(this.requestTimeoutMs, () =>
        fail(new Error("Daemon result acknowledgement timed out")),
      );
      socket.once("error", fail);
      socket.once("connect", () => {
        try {
          this.writeFrame(socket, acknowledgement);
        } catch (error) {
          fail(error);
        }
      });
      socket.on("data", (bytes) => {
        try {
          const values = decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
          for (const response of values) {
            if (responseReceived) throw new Error("Duplicate daemon result acknowledgement");
            LocalDaemonTransport.assertResponse(response);
            if (
              response.kind !== "result-acknowledged" ||
              response.instanceId !== request.instanceId ||
              response.processToken !== request.processToken ||
              response.requestId !== request.requestId ||
              response.transferId !== manifest.transferId
            ) {
              throw new Error("Invalid daemon result acknowledgement");
            }
            responseReceived = true;
          }
          if (responseReceived) socket.end();
        } catch (error) {
          fail(error);
        }
      });
      socket.once("end", complete);
      socket.once("close", () => {
        if (!settled) complete();
      });
    });
  }

  async executionStatus(
    endpoint: string,
    request: DaemonExecutionStatusRequest,
  ): Promise<DaemonExecutionStatus> {
    const response = await this.singleResponse(endpoint, request);
    if (response.kind !== "execution-status") {
      throw new DaemonTransportError(
        "corrupt",
        "accepted",
        "Daemon returned a non-status response",
      );
    }
    return response.status;
  }

  async listen(endpoint: string, handler: DaemonRequestHandler): Promise<DaemonServer> {
    if (process.platform !== "win32") {
      mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
      if (existsSync(endpoint)) {
        if (await this.endpointIsReachable(endpoint)) {
          throw new Error(`Daemon endpoint is already in use: ${endpoint}`);
        }
        rmSync(endpoint, { force: true });
      }
    }
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      this.serve(socket, handler);
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => resolve(new ListeningDaemonServer(server, sockets)));
    });
  }

  async removeUnavailableEndpoint(endpoint: string): Promise<boolean> {
    if (await this.endpointIsReachable(endpoint)) return false;
    if (process.platform !== "win32") rmSync(endpoint, { force: true });
    return true;
  }

  private endpointIsReachable(endpoint: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(endpoint);
      const finish = (reachable: boolean): void => {
        socket.destroy();
        resolve(reachable);
      };
      socket.setTimeout(this.requestTimeoutMs, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  private serve(socket: Socket, handler: DaemonRequestHandler): void {
    const decoder = this.codec.controlDecoder();
    let responses = Promise.resolve();
    let writes = Promise.resolve();
    const closeListeners = new Set<() => void>();
    const send: DaemonServerSend = Object.assign(
      (message: DaemonServerMessage) => {
        const write = writes.then(() => this.writeServerMessage(socket, message));
        writes = write;
        return write;
      },
      {
        onClose: (listener: () => void): (() => void) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
      },
    );
    socket.on("data", (bytes) => {
      try {
        for (const value of decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
          LocalDaemonTransport.assertRequest(value);
          responses = responses
            .then(async () => {
              const response = await handler(value, send);
              if (response !== undefined) await send(response);
            })
            .catch(() => {
              socket.destroy();
            });
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once("end", () => {
      try {
        decoder.assertComplete();
      } catch {
        socket.destroy();
      }
    });
    socket.once("close", () => {
      for (const listener of closeListeners) {
        try {
          listener();
        } catch {}
      }
      closeListeners.clear();
    });
    socket.once("error", () => socket.destroy());
  }

  private writeFrame(socket: Socket, value: unknown): void {
    this.writeEncodedFrame(socket, this.codec.encodeControl(value));
  }

  private async writeServerMessage(socket: Socket, message: DaemonServerMessage): Promise<void> {
    await this.writeEncodedServerFrame(socket, this.codec.encodeServerMessage(message));
  }

  private async writeEncodedServerFrame(socket: Socket, frame: Uint8Array): Promise<void> {
    const chunkSize = this.writeChunkSize ?? frame.length;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      if (socket.destroyed) throw new Error("Daemon socket closed during response delivery");
      const accepted = socket.write(frame.subarray(offset, offset + chunkSize));
      if (!accepted) await LocalDaemonTransport.waitForDrain(socket);
    }
  }

  private static waitForDrain(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        socket.off("drain", drained);
        socket.off("error", failed);
        socket.off("close", closed);
      };
      const drained = (): void => {
        cleanup();
        resolve();
      };
      const failed = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const closed = (): void => {
        cleanup();
        reject(new Error("Daemon socket closed during response delivery"));
      };
      socket.once("drain", drained);
      socket.once("error", failed);
      socket.once("close", closed);
    });
  }

  private writeEncodedFrame(socket: Pick<Socket, "write">, frame: Uint8Array): void {
    if (this.writeChunkSize === undefined) {
      socket.write(frame);
      return;
    }
    for (let offset = 0; offset < frame.length; offset += this.writeChunkSize) {
      socket.write(frame.subarray(offset, offset + this.writeChunkSize));
    }
  }

  private static responseFor(
    request: DaemonLifecycleRequest | DaemonExecutionStatusRequest,
    value: unknown,
  ): DaemonLifecycleResponse | DaemonExecutionStatusResponse {
    LocalDaemonTransport.assertResponse(value);
    if (request.kind === "identify") {
      if (value.kind !== "identity") {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-identity response");
      }
      if (value.instanceId !== request.instanceId || value.processToken !== request.processToken) {
        throw new DaemonResponseError(
          "authentication",
          "Daemon identity does not match process instance",
          value.instanceId === request.instanceId ? value.instanceId : undefined,
        );
      }
      return value;
    }
    if (request.kind === "terminate" || request.kind === "kill") {
      const expectedKind = request.kind === "terminate" ? "terminating" : "killing";
      if (value.kind !== expectedKind) {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-termination response");
      }
      if (value.instanceId !== request.instanceId || value.processToken !== request.processToken) {
        throw new DaemonResponseError(
          "authentication",
          "Daemon termination does not match process instance",
          value.instanceId === request.instanceId ? value.instanceId : undefined,
        );
      }
      return value;
    }
    if (request.kind === "ping") {
      if (value.kind !== "pong") {
        throw new DaemonResponseError(
          "corrupt",
          "Daemon pong does not match request protocol and instance",
        );
      }
      if (value.instanceId !== request.instanceId) {
        throw new DaemonResponseError(
          "authentication",
          "Daemon pong does not match request instance",
        );
      }
      if (value.protocolVersion !== request.protocolVersion) {
        throw new DaemonResponseError(
          "incompatible",
          "Daemon pong does not match request protocol",
          value.instanceId,
        );
      }
      return value;
    }
    if (request.kind === "execution-status") {
      if (value.kind !== "execution-status") {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-status response");
      }
      LocalDaemonTransport.assertExecutionCoordinates(request, value);
      return value;
    }
    if (value.kind !== "stopped") {
      throw new DaemonResponseError("corrupt", "Daemon returned a non-stop response");
    }
    if (value.instanceId !== request.instanceId) {
      throw new DaemonResponseError(
        "authentication",
        "Daemon stop response does not match instance",
      );
    }
    return value;
  }

  private static assertRequest(value: unknown): asserts value is DaemonRequest {
    if (!LocalDaemonTransport.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon request");
    }
    if (value.kind === "identify" || value.kind === "terminate" || value.kind === "kill") {
      if (typeof value.instanceId !== "string" || typeof value.processToken !== "string") {
        throw new Error("Malformed daemon identity request");
      }
      return;
    }
    if (typeof value.protocolVersion !== "number" || typeof value.instanceId !== "string") {
      throw new Error("Malformed daemon request envelope");
    }
    if (value.kind === "ping" || value.kind === "stop") return;
    if (
      (value.kind !== "execute" &&
        value.kind !== "execution-status" &&
        value.kind !== "result-fetch" &&
        value.kind !== "result-ack") ||
      typeof value.processToken !== "string" ||
      !DaemonRuntimeValues.isRequestId(value.requestId) ||
      (value.kind === "execute" && !DaemonRuntimeValues.isCommandName(value.commandName)) ||
      (value.kind === "execute" && !LocalDaemonTransport.isExecutionRequest(value.request)) ||
      (value.kind === "result-fetch" && !LocalDaemonTransport.isCount(value.offset)) ||
      (value.kind === "result-ack" && typeof value.transferId !== "string")
    ) {
      throw new Error("Malformed daemon execution request");
    }
  }

  private static assertResponse(value: unknown): asserts value is DaemonResponse {
    if (!LocalDaemonTransport.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon response");
    }
    if (value.kind === "pong") {
      if (
        typeof value.protocolVersion !== "number" ||
        typeof value.instanceId !== "string" ||
        typeof value.symnavVersion !== "string" ||
        (value.state !== undefined &&
          value.state !== "starting" &&
          value.state !== "ready" &&
          value.state !== "busy") ||
        (value.startedAt !== undefined && typeof value.startedAt !== "number") ||
        (value.fileCount !== undefined && typeof value.fileCount !== "number") ||
        (value.memoryBytes !== undefined && typeof value.memoryBytes !== "number") ||
        (value.lastNavigationAt !== undefined && typeof value.lastNavigationAt !== "number") ||
        (value.currentCommand !== undefined && typeof value.currentCommand !== "string") ||
        (value.currentCommandElapsedMs !== undefined &&
          typeof value.currentCommandElapsedMs !== "number") ||
        (value.queued !== undefined && typeof value.queued !== "number") ||
        (value.activity !== undefined && !LocalDaemonTransport.isActivitySnapshot(value.activity))
      ) {
        throw new Error("Malformed daemon pong");
      }
      return;
    }
    if (value.kind === "identity") {
      if (
        typeof value.instanceId !== "string" ||
        typeof value.processToken !== "string" ||
        !Number.isInteger(value.pid) ||
        typeof value.startedAt !== "number"
      ) {
        throw new Error("Malformed daemon identity");
      }
      return;
    }
    if (value.kind === "terminating" || value.kind === "killing") {
      if (typeof value.instanceId !== "string" || typeof value.processToken !== "string") {
        throw new Error("Malformed daemon termination response");
      }
      return;
    }
    if (value.kind === "stopped") {
      if (typeof value.instanceId !== "string") throw new Error("Malformed daemon stop response");
      return;
    }
    if (
      value.kind === "accepted" ||
      value.kind === "rejected" ||
      value.kind === "result-manifest" ||
      value.kind === "result-end" ||
      value.kind === "execution-failed"
    ) {
      LocalDaemonTransport.assertExecutionFrame(value);
      return;
    }
    if (value.kind === "execution-status") {
      if (
        typeof value.instanceId !== "string" ||
        typeof value.processToken !== "string" ||
        !DaemonRuntimeValues.isRequestId(value.requestId) ||
        !LocalDaemonTransport.isExecutionStatus(value.status)
      ) {
        throw new Error("Malformed daemon execution status");
      }
      return;
    }
    if (value.kind === "result-acknowledged") {
      if (
        typeof value.instanceId !== "string" ||
        typeof value.processToken !== "string" ||
        !DaemonRuntimeValues.isRequestId(value.requestId) ||
        typeof value.transferId !== "string"
      ) {
        throw new Error("Malformed daemon result acknowledgement");
      }
      return;
    }
    throw new Error("Malformed daemon response");
  }

  private static transportError(
    error: unknown,
    delivery: DaemonDeliveryState,
  ): DaemonTransportError {
    if (error instanceof DaemonTransportError) return error;
    if (error instanceof DaemonResponseError) {
      return new DaemonTransportError(
        error.code,
        "accepted",
        error.message,
        error.authenticatedInstanceId,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DaemonTransportError("corrupt", delivery, message);
  }

  private static executionFrameFor(
    request: DaemonExecuteRequest,
    value: unknown,
  ): DaemonExecutionServerFrame {
    LocalDaemonTransport.assertResponse(value);
    if (
      value.kind !== "accepted" &&
      value.kind !== "rejected" &&
      value.kind !== "result-manifest" &&
      value.kind !== "result-end" &&
      value.kind !== "execution-failed"
    ) {
      throw new DaemonResponseError("corrupt", "Daemon returned a non-execution frame");
    }
    LocalDaemonTransport.assertExecutionCoordinates(request, value);
    return value;
  }

  private static assertExecutionCoordinates(
    request: Pick<DaemonExecuteRequest, "instanceId" | "processToken" | "requestId">,
    response: Pick<DaemonExecutionServerFrame, "instanceId" | "processToken" | "requestId">,
  ): void {
    if (response.instanceId !== request.instanceId) {
      throw new DaemonResponseError("authentication", "Daemon execution instance does not match");
    }
    if (response.processToken !== request.processToken) {
      throw new DaemonResponseError(
        "authentication",
        "Daemon execution process token does not match",
        response.instanceId,
      );
    }
    if (response.requestId !== request.requestId) {
      throw new DaemonResponseError(
        "corrupt",
        "Daemon execution request identifier does not match",
        response.instanceId,
      );
    }
  }

  private static assertExecutionFrame(
    value: Record<string, unknown>,
  ): asserts value is DaemonExecutionServerFrame {
    if (
      typeof value.instanceId !== "string" ||
      typeof value.processToken !== "string" ||
      !DaemonRuntimeValues.isRequestId(value.requestId)
    ) {
      throw new Error("Malformed daemon execution frame");
    }
    if (value.kind === "accepted") {
      if (
        !LocalDaemonTransport.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "acceptedAt",
          "queuePosition",
        ]) ||
        !LocalDaemonTransport.isMetric(value.acceptedAt) ||
        !LocalDaemonTransport.isCount(value.queuePosition)
      ) {
        throw new Error("Malformed daemon acceptance");
      }
      return;
    }
    if (value.kind === "rejected") {
      if (
        !LocalDaemonTransport.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "code",
          "retrySafe",
        ]) ||
        typeof value.retrySafe !== "boolean"
      ) {
        throw new Error("Malformed daemon execution rejection");
      }
      try {
        DaemonAdmissionRejections.assertConsistent(
          value as unknown as DaemonRejectedExecutionFrame,
        );
      } catch {
        throw new Error("Malformed daemon execution rejection");
      }
      return;
    }
    if (value.kind === "result-manifest") {
      if (
        !LocalDaemonTransport.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "manifest",
        ]) ||
        !LocalDaemonTransport.isCompletionManifest(value.manifest) ||
        value.manifest.instanceId !== value.instanceId ||
        value.manifest.requestId !== value.requestId
      ) {
        throw new Error("Malformed daemon result manifest");
      }
      return;
    }
    if (value.kind === "result-end") {
      if (
        !LocalDaemonTransport.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "transferId",
          "rawBytes",
          "recordCount",
          "sha256",
        ]) ||
        typeof value.transferId !== "string" ||
        !LocalDaemonTransport.isCount(value.rawBytes) ||
        !LocalDaemonTransport.isCount(value.recordCount) ||
        !LocalDaemonTransport.isDigest(value.sha256)
      ) {
        throw new Error("Malformed daemon result end");
      }
      return;
    }
    if (
      !LocalDaemonTransport.hasExactKeys(value, [
        "kind",
        "instanceId",
        "processToken",
        "requestId",
        "code",
      ]) ||
      !DaemonExecutionFailures.isCode(value.code)
    ) {
      throw new Error("Malformed daemon execution failure");
    }
  }

  private static isCompletionManifest(value: unknown): value is CompletionSpoolManifest {
    return (
      LocalDaemonTransport.isRecord(value) &&
      LocalDaemonTransport.hasExactKeys(value, [
        "transferId",
        "requestId",
        "instanceId",
        "exitCode",
        "rawBytes",
        "recordCount",
        "sha256",
      ]) &&
      typeof value.transferId === "string" &&
      value.transferId.length > 0 &&
      DaemonRuntimeValues.isRequestId(value.requestId) &&
      typeof value.instanceId === "string" &&
      value.instanceId.length > 0 &&
      LocalDaemonTransport.isCount(value.exitCode) &&
      LocalDaemonTransport.isCount(value.rawBytes) &&
      LocalDaemonTransport.isCount(value.recordCount) &&
      LocalDaemonTransport.isDigest(value.sha256)
    );
  }

  private static isDigest(value: unknown): value is string {
    return typeof value === "string" && /^[a-f\d]{64}$/.test(value);
  }

  private static isExecutionStatus(value: unknown): value is DaemonExecutionStatus {
    if (!LocalDaemonTransport.isRecord(value)) return false;
    if (value.state === "unknown" || value.state === "completed") return true;
    if (value.state === "queued") return LocalDaemonTransport.isCount(value.queuePosition);
    if (value.state === "running") return LocalDaemonTransport.isMetric(value.startedAt);
    return value.state === "failed" && DaemonExecutionFailures.isCode(value.code);
  }

  private static isActivitySnapshot(value: unknown): boolean {
    if (!LocalDaemonTransport.isRecord(value)) return false;
    const lifecycle = value.lifecycle;
    const current = value.current;
    const expectedKeys = [
      "lifecycle",
      "pid",
      "startedAt",
      "startupElapsedMs",
      "processRssBytes",
      "hardProcessRssBytes",
      "workerGeneration",
      "queued",
      "spoolBytes",
    ];
    if (value.workerHeapUsedBytes !== undefined) expectedKeys.push("workerHeapUsedBytes");
    if (value.lastCompletedAgoMs !== undefined) expectedKeys.push("lastCompletedAgoMs");
    if (
      lifecycle === "ready" ||
      lifecycle === "busy" ||
      ((lifecycle === "recovering" || lifecycle === "draining") && value.fileCount !== undefined)
    ) {
      expectedKeys.push("fileCount");
    }
    if (lifecycle === "busy") expectedKeys.push("current");
    if (lifecycle === "recovering") expectedKeys.push("recoveryDetail");
    return (
      (lifecycle === "starting" ||
        lifecycle === "ready" ||
        lifecycle === "busy" ||
        lifecycle === "recovering" ||
        lifecycle === "draining") &&
      LocalDaemonTransport.hasExactKeys(value, expectedKeys) &&
      (lifecycle !== "recovering" ||
        value.recoveryDetail === "resource-pressure" ||
        value.recoveryDetail === "worker-replacement") &&
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      LocalDaemonTransport.isMetric(value.startedAt) &&
      LocalDaemonTransport.isMetric(value.startupElapsedMs) &&
      (lifecycle === "ready" || lifecycle === "busy"
        ? LocalDaemonTransport.isCount(value.fileCount)
        : lifecycle === "starting"
          ? value.fileCount === undefined
          : value.fileCount === undefined || LocalDaemonTransport.isCount(value.fileCount)) &&
      LocalDaemonTransport.isCount(value.processRssBytes) &&
      LocalDaemonTransport.isCount(value.hardProcessRssBytes) &&
      (value.workerHeapUsedBytes === undefined ||
        LocalDaemonTransport.isCount(value.workerHeapUsedBytes)) &&
      LocalDaemonTransport.isCount(value.workerGeneration) &&
      (lifecycle !== "busy" ||
        (LocalDaemonTransport.isRecord(current) &&
          LocalDaemonTransport.hasExactKeys(current, ["requestId", "command", "elapsedMs"]) &&
          DaemonRuntimeValues.isRequestId(current.requestId) &&
          DaemonRuntimeValues.isCommandName(current.command) &&
          LocalDaemonTransport.isMetric(current.elapsedMs))) &&
      LocalDaemonTransport.isCount(value.queued) &&
      (value.lastCompletedAgoMs === undefined ||
        LocalDaemonTransport.isMetric(value.lastCompletedAgoMs)) &&
      LocalDaemonTransport.isCount(value.spoolBytes)
    );
  }

  private static isCount(value: unknown): boolean {
    return Number.isInteger(value) && (value as number) >= 0;
  }

  private static isMetric(value: unknown): boolean {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  private static isExecutionRequest(value: unknown): boolean {
    if (!LocalDaemonTransport.isRecord(value)) return false;
    return (
      LocalDaemonTransport.hasExactKeys(value, [
        "argv",
        "cwd",
        "telemetryEnabled",
        "executionMode",
      ]) &&
      Array.isArray(value.argv) &&
      value.argv.every((arg) => typeof arg === "string") &&
      typeof value.cwd === "string" &&
      typeof value.telemetryEnabled === "boolean" &&
      (value.executionMode === "cold" ||
        value.executionMode === "warm" ||
        value.executionMode === "fallback")
    );
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static isResultChunk(value: unknown): value is DaemonResultChunk {
    return (
      LocalDaemonTransport.isRecord(value) &&
      !("kind" in value) &&
      value.bytes instanceof Uint8Array
    );
  }

  private static hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
  }
}
