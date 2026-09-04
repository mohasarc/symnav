import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  DaemonAdmissionRejections,
  type DaemonExecuteRejectionCode,
  type DaemonExecutionFailureCode,
  type DaemonPolicyValues,
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
  DaemonSocketClient,
} from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { DaemonProtocolError, DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import { DaemonClientResultCapture } from "./daemon-client-result-capture.js";
import { DaemonResultTransferReceiver } from "./daemon-result-transfer-receiver.js";
import { LocalDaemonSocketClient } from "./local-daemon-socket-client.js";

interface LocalDaemonTransportOptions {
  readonly responseTimeoutPurpose?: "ordinary" | "status-observer";
  readonly writeChunkSize?: number;
  readonly outputDirectory?: string;
  readonly sockets?: DaemonSocketClient;
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
  private readonly validator = new DaemonProtocolValidator();
  private readonly outputPolicy: DaemonPolicyValues["output"];
  private readonly deliveryPolicy: DaemonPolicyValues["delivery"];
  private readonly sockets: DaemonSocketClient;

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
    this.sockets =
      options.sockets ??
      new LocalDaemonSocketClient(
        options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize },
      );
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
  private async singleResponse(
    endpoint: string,
    request: DaemonLifecycleRequest | DaemonExecutionStatusRequest,
  ): Promise<DaemonLifecycleResponse | DaemonExecutionStatusResponse> {
    this.validator.request(request);
    const decoder = this.codec.controlDecoder();
    let connection: Awaited<ReturnType<DaemonSocketClient["connect"]>>;
    let delivery: DaemonDeliveryState = "not-submitted";
    try {
      connection = await this.sockets.connect(endpoint, this.requestTimeoutMs);
    } catch (error) {
      if (LocalDaemonTransport.isSocketTimeout(error)) {
        throw new DaemonTransportError("timeout", delivery, "Daemon request timed out");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonTransportError("unreachable", delivery, message);
    }
    try {
      connection.write(this.codec.encodeControl(request));
      delivery = "submitted-unconfirmed";
    } catch (error) {
      connection.destroy();
      throw LocalDaemonTransport.transportError(error, delivery);
    }
    try {
      for await (const bytes of connection.incoming) {
        try {
          const values = decoder.append(bytes);
          if (values.length > 1) throw new Error("Daemon returned multiple responses");
          const value = values[0];
          if (value === undefined) continue;
          const response =
            request.kind === "execution-status"
              ? this.validator.executionStatusResponse(request, value)
              : this.validator.lifecycleResponse(request, value);
          delivery = "accepted";
          connection.end();
          return response;
        } catch (error) {
          throw LocalDaemonTransport.transportError(error, delivery);
        }
      }
      try {
        decoder.assertComplete();
      } catch (error) {
        throw LocalDaemonTransport.transportError(error, delivery);
      }
      throw new DaemonTransportError(
        "closed",
        delivery,
        "Daemon connection ended before a response",
      );
    } catch (error) {
      connection.destroy();
      if (LocalDaemonTransport.isSocketTimeout(error)) {
        throw new DaemonTransportError("timeout", delivery, "Daemon request timed out");
      }
      if (!(error instanceof DaemonTransportError) && !(error instanceof DaemonProtocolError)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DaemonTransportError("closed", delivery, message);
      }
      throw LocalDaemonTransport.transportError(error, delivery);
    }
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
    this.validator.request(request);
    return new Promise((resolve, reject) => {
      const decoder = this.codec.transferDecoder();
      const output = new DaemonClientResultCapture({
        policy: this.outputPolicy,
        ...(this.outputDirectory === undefined ? {} : { directory: this.outputDirectory }),
      });
      const transfer = new DaemonResultTransferReceiver(request.requestId, output);
      let connection: Awaited<ReturnType<DaemonSocketClient["connect"]>> | undefined;
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
      const fail = (error: unknown): void => {
        const transportError = LocalDaemonTransport.transportError(error, delivery);
        connection?.destroy();
        if (!outerSettled) {
          outerSettled = true;
          void transfer.dispose().finally(() => reject(transportError));
          return;
        }
        if (!completionSettled) {
          completionSettled = true;
          void transfer.dispose().finally(() => rejectCompletion(transportError));
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
        connection?.destroy();
        transfer.beginConnection();
        void this.fetchCompletion(endpoint, request, transfer)
          .then((completionValue) => {
            if (completionSettled) return;
            completionSettled = true;
            resolveCompletion(completionValue);
          })
          .catch(fail);
        return true;
      };
      const publishAcceptance = (): void => {
        if (acceptance === undefined || outerSettled) return;
        outerSettled = true;
        connection?.disableTimeout();
        resolve({ acceptance, completion });
      };
      const consume = async (bytes: Uint8Array): Promise<void> => {
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
          const frame = this.validator.executionFrame(request, value);
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
          try {
            await this.acknowledgeResult(endpoint, request, completedManifest);
          } catch (error) {
            await result.output.dispose();
            throw error;
          }
          if (!completionSettled) {
            completionSettled = true;
            connection?.end();
            resolveCompletion({ status: "completed", result });
          }
        }
        if (failedCode !== undefined && !completionSettled) {
          completionSettled = true;
          connection?.end();
          await transfer.dispose();
          resolveCompletion({ status: "failed", code: failedCode });
        }
      };
      const receive = async (): Promise<void> => {
        try {
          connection = await this.sockets.connect(endpoint, this.executionRequestTimeoutMs);
        } catch (error) {
          if (LocalDaemonTransport.isSocketTimeout(error)) {
            fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out"));
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          fail(new DaemonTransportError("unreachable", delivery, message));
          return;
        }
        try {
          connection.write(this.codec.encodeControl(request));
          delivery = "submitted-unconfirmed";
        } catch (error) {
          fail(error);
          return;
        }
        try {
          for await (const bytes of connection.incoming) {
            try {
              await consume(bytes);
            } catch (error) {
              throw LocalDaemonTransport.transportError(error, delivery);
            }
          }
          if (terminal && completionSettled) return;
          if (resume()) return;
          try {
            decoder.assertComplete();
          } catch (error) {
            fail(error);
            return;
          }
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
        } catch (error) {
          if (error instanceof DaemonTransportError || error instanceof DaemonProtocolError) {
            fail(error);
            return;
          }
          if (LocalDaemonTransport.isSocketTimeout(error)) {
            fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out"));
            return;
          }
          if (resume()) return;
          const message = error instanceof Error ? error.message : String(error);
          fail(new DaemonTransportError("closed", delivery, message, acceptance?.instanceId));
        }
      };
      void receive();
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
          const frame = this.validator.executionFrame(request, value);
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
          try {
            await this.acknowledgeResult(endpoint, request, manifest);
          } catch (error) {
            await result.output.dispose();
            throw error;
          }
          settled = true;
          socket.end();
          resolve({ status: "completed", result });
        }
        if (failedCode !== undefined) {
          settled = true;
          socket.end();
          await transfer.dispose();
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
            this.validator.resultAcknowledgement(request, manifest.transferId, response);
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
          const request = this.validator.request(value);
          responses = responses
            .then(async () => {
              const response = await handler(request, send);
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

  private static transportError(
    error: unknown,
    delivery: DaemonDeliveryState,
  ): DaemonTransportError {
    if (error instanceof DaemonTransportError) return error;
    if (error instanceof DaemonProtocolError) {
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

  private static isSocketTimeout(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { readonly code?: unknown }).code === "ETIMEDOUT"
    );
  }

  private static isResultChunk(value: unknown): value is DaemonResultChunk {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !("kind" in value) &&
      "bytes" in value &&
      value.bytes instanceof Uint8Array
    );
  }
}
