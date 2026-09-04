import { type DaemonExecutionFailureCode, type DaemonPolicyValues } from "@symnav/daemon";
import type {
  DaemonExecuteRequest,
  DaemonExecutionServerFrame,
  DaemonExecutionStatusRequest,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonResultChunk,
  DaemonServer,
} from "./daemon-protocol.js";
import type {
  DaemonExecutionAcceptance,
  DaemonExecutionReceipt,
  DaemonExecutionRequester,
  DaemonLifecycleRequester,
  DaemonRequestHandler,
  DaemonRequestServer,
  DaemonSocketClient,
} from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { DaemonProtocolError, DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import { DaemonClientResultCapture } from "./daemon-client-result-capture.js";
import { DaemonResultTransferReceiver } from "./daemon-result-transfer-receiver.js";
import { LocalDaemonSocketClient } from "./local-daemon-socket-client.js";
import { DaemonLifecycleClient } from "./daemon-lifecycle-client.js";
import { DaemonTransportError, type DaemonDeliveryState } from "./daemon-transport-error.js";
import { LocalDaemonSocketServer } from "./local-daemon-socket-server.js";

interface LocalDaemonTransportOptions {
  readonly lifecycleResponseTimeoutMs?: number;
  readonly writeChunkSize?: number;
  readonly outputDirectory?: string;
  readonly sockets?: DaemonSocketClient;
}

export type LocalDaemonTransportPolicy = Pick<
  DaemonPolicyValues,
  "transport" | "delivery" | "output"
>;

export class LocalDaemonTransport
  implements DaemonLifecycleRequester, DaemonExecutionRequester, DaemonRequestServer
{
  private readonly executionRequestTimeoutMs: number;
  private readonly outputDirectory: string | undefined;
  private readonly codec: DaemonWireCodec;
  private readonly validator = new DaemonProtocolValidator();
  private readonly outputPolicy: DaemonPolicyValues["output"];
  private readonly deliveryPolicy: DaemonPolicyValues["delivery"];
  private readonly sockets: DaemonSocketClient;
  private readonly lifecycle: DaemonLifecycleClient;
  private readonly server: DaemonRequestServer;

  constructor(policy: LocalDaemonTransportPolicy, options: LocalDaemonTransportOptions = {}) {
    this.executionRequestTimeoutMs = policy.transport.executionAdmissionTimeoutMs;
    this.codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes: policy.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
    });
    this.outputPolicy = policy.output;
    this.deliveryPolicy = policy.delivery;
    this.outputDirectory = options.outputDirectory;
    this.sockets =
      options.sockets ??
      new LocalDaemonSocketClient(
        options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize },
      );
    this.lifecycle = new DaemonLifecycleClient({
      sockets: this.sockets,
      codec: this.codec,
      validator: this.validator,
      responseTimeoutMs:
        options.lifecycleResponseTimeoutMs ?? policy.transport.singleResponseTimeoutMs,
    });
    this.server = new LocalDaemonSocketServer({
      sockets: this.sockets,
      codec: this.codec,
      validator: this.validator,
      policy: policy.transport,
      ...(options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize }),
    });
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
    return this.lifecycle.request(endpoint, request);
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
          .catch((error: unknown) => {
            if (
              LocalDaemonTransport.isAcceptedConnectionClose(error, request) &&
              resume()
            ) {
              return;
            }
            fail(error);
          });
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

  private async fetchCompletion(
    endpoint: string,
    request: DaemonExecuteRequest,
    transfer: DaemonResultTransferReceiver,
  ): DaemonExecutionReceipt["completion"] {
    const decoder = this.codec.transferDecoder();
    let connection: Awaited<ReturnType<DaemonSocketClient["connect"]>>;
    try {
      connection = await this.sockets.connect(endpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonTransportError("closed", "accepted", message, request.instanceId);
    }
    try {
      connection.write(
        this.codec.encodeControl({
          kind: "result-fetch",
          protocolVersion: request.protocolVersion,
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          offset: transfer.nextOffset,
        }),
      );
    } catch (error) {
      connection.destroy();
      throw LocalDaemonTransport.transportError(error, "accepted");
    }
    let ended = false;
    try {
      for await (const bytes of connection.incoming) {
        try {
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
            connection.end();
            return { status: "completed", result };
          }
          if (failedCode !== undefined) {
            connection.end();
            await transfer.dispose();
            return { status: "failed", code: failedCode };
          }
        } catch (error) {
          throw LocalDaemonTransport.transportError(error, "accepted");
        }
      }
      try {
        decoder.assertComplete();
      } catch (error) {
        throw LocalDaemonTransport.transportError(error, "accepted");
      }
      throw new DaemonTransportError(
        "closed",
        "accepted",
        "Daemon result resume ended before completion",
        request.instanceId,
      );
    } catch (error) {
      connection.destroy();
      if (error instanceof DaemonTransportError || error instanceof DaemonProtocolError) {
        throw LocalDaemonTransport.transportError(error, "accepted");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonTransportError("closed", "accepted", message, request.instanceId);
    }
  }

  private async acknowledgeResult(
    endpoint: string,
    request: DaemonExecuteRequest,
    manifest: Extract<DaemonExecutionServerFrame, { kind: "result-manifest" }>["manifest"],
  ): Promise<void> {
    return this.lifecycle.acknowledgeResult(endpoint, request, manifest.transferId);
  }

  executionStatus(
    endpoint: string,
    request: DaemonExecutionStatusRequest,
  ): ReturnType<DaemonLifecycleClient["executionStatus"]> {
    return this.lifecycle.executionStatus(endpoint, request);
  }

  async listen(endpoint: string, handler: DaemonRequestHandler): Promise<DaemonServer> {
    return this.server.listen(endpoint, handler);
  }

  async removeUnavailableEndpoint(endpoint: string): Promise<boolean> {
    return this.server.removeUnavailableEndpoint(endpoint);
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
