import { type DaemonExecutionFailureCode, type DaemonPolicyValues } from "@symnav/daemon";
import type { DaemonOutputCapture } from "./daemon-client-result-capture.js";
import type { DaemonLifecycleClient } from "./daemon-lifecycle-client.js";
import type {
  DaemonExecuteRequest,
  DaemonExecutionServerFrame,
  DaemonResultChunk,
} from "./daemon-protocol.js";
import { DaemonProtocolError, type DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import { DaemonResultTransferReceiver } from "./daemon-result-transfer-receiver.js";
import type {
  DaemonExecutionAcceptance,
  DaemonExecutionReceipt,
  DaemonExecutionRequester,
  DaemonSocketClient,
} from "./daemon-transport.js";
import { DaemonTransportError, type DaemonDeliveryState } from "./daemon-transport-error.js";
import type { DaemonWireCodec } from "./daemon-wire-codec.js";

interface DaemonExecutionClientOptions {
  readonly sockets: DaemonSocketClient;
  readonly lifecycle: Pick<DaemonLifecycleClient, "acknowledgeResult">;
  readonly codec: DaemonWireCodec;
  readonly validator: DaemonProtocolValidator;
  readonly createOutput: () => DaemonOutputCapture;
  readonly transportPolicy: DaemonPolicyValues["transport"];
  readonly deliveryPolicy: DaemonPolicyValues["delivery"];
}

export class DaemonExecutionClient implements DaemonExecutionRequester {
  constructor(private readonly options: DaemonExecutionClientOptions) {}

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
          !DaemonExecutionClient.isAcceptedConnectionClose(firstError, request) ||
          reattachmentCount >= this.options.deliveryPolicy.postAcceptanceExecutionReattachmentLimit
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
    this.options.validator.request(request);
    return new Promise((resolve, reject) => {
      const decoder = this.options.codec.transferDecoder();
      const transfer = new DaemonResultTransferReceiver(
        request.requestId,
        this.options.createOutput(),
      );
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
        const transportError = DaemonExecutionClient.transportError(error, delivery);
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
          resumeCount >= this.options.deliveryPolicy.resultTransferResumeLimitPerExecutionAttempt ||
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
            if (DaemonExecutionClient.isAcceptedConnectionClose(error, request) && resume()) {
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
          if (DaemonExecutionClient.isResultChunk(value)) {
            if (acceptance === undefined)
              throw new Error("Daemon returned output before acceptance");
            await transfer.acceptChunk(value);
            continue;
          }
          const frame = this.options.validator.executionFrame(request, value);
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
            await this.options.lifecycle.acknowledgeResult(
              endpoint,
              request,
              completedManifest.transferId,
            );
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
          connection = await this.options.sockets.connect(
            endpoint,
            this.options.transportPolicy.executionAdmissionTimeoutMs,
          );
        } catch (error) {
          if (DaemonExecutionClient.isSocketTimeout(error)) {
            fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out"));
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          fail(new DaemonTransportError("unreachable", delivery, message));
          return;
        }
        try {
          connection.write(this.options.codec.encodeControl(request));
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
              throw DaemonExecutionClient.transportError(error, delivery);
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
          if (DaemonExecutionClient.isSocketTimeout(error)) {
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

  private async fetchCompletion(
    endpoint: string,
    request: DaemonExecuteRequest,
    transfer: DaemonResultTransferReceiver,
  ): DaemonExecutionReceipt["completion"] {
    const decoder = this.options.codec.transferDecoder();
    let connection: Awaited<ReturnType<DaemonSocketClient["connect"]>>;
    try {
      connection = await this.options.sockets.connect(endpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonTransportError("closed", "accepted", message, request.instanceId);
    }
    try {
      connection.write(
        this.options.codec.encodeControl({
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
      throw DaemonExecutionClient.transportError(error, "accepted");
    }
    let ended = false;
    try {
      for await (const bytes of connection.incoming) {
        try {
          let completedResult = false;
          let failedCode: DaemonExecutionFailureCode | undefined;
          for (const value of decoder.append(bytes)) {
            if (ended) throw new Error("Daemon resumed with a duplicate terminal frame");
            if (DaemonExecutionClient.isResultChunk(value)) {
              await transfer.acceptChunk(value);
              continue;
            }
            const frame = this.options.validator.executionFrame(request, value);
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
              await this.options.lifecycle.acknowledgeResult(
                endpoint,
                request,
                manifest.transferId,
              );
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
          throw DaemonExecutionClient.transportError(error, "accepted");
        }
      }
      try {
        decoder.assertComplete();
      } catch (error) {
        throw DaemonExecutionClient.transportError(error, "accepted");
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
        throw DaemonExecutionClient.transportError(error, "accepted");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonTransportError("closed", "accepted", message, request.instanceId);
    }
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
