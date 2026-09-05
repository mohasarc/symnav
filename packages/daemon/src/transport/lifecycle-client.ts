import type {
  DaemonExecuteRequest,
  DaemonExecutionStatus,
  DaemonExecutionStatusRequest,
  DaemonExecutionStatusResponse,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonResultAcknowledgement,
} from "./protocol.js";
import { DaemonProtocolError, type DaemonProtocolValidator } from "./protocol-validator.js";
import { DaemonTransportError, type DaemonDeliveryState } from "./transport-error.js";
import type { DaemonLifecycleRequester, DaemonSocketClient } from "./contracts.js";
import type { DaemonWireCodec } from "./wire-codec.js";

interface DaemonLifecycleClientOptions {
  readonly sockets: DaemonSocketClient;
  readonly codec: DaemonWireCodec;
  readonly validator: DaemonProtocolValidator;
  readonly responseTimeoutMs: number;
}

export class DaemonLifecycleClient implements DaemonLifecycleRequester {
  constructor(private readonly options: DaemonLifecycleClientOptions) {}

  request(endpoint: string, request: DaemonLifecycleRequest): Promise<DaemonLifecycleResponse> {
    return this.singleResponse(endpoint, request);
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

  async acknowledgeResult(
    endpoint: string,
    request: Pick<
      DaemonExecuteRequest,
      "protocolVersion" | "instanceId" | "processToken" | "requestId"
    >,
    transferId: string,
  ): Promise<void> {
    const acknowledgement: DaemonResultAcknowledgement = {
      kind: "result-ack",
      protocolVersion: request.protocolVersion,
      instanceId: request.instanceId,
      processToken: request.processToken,
      requestId: request.requestId,
      transferId,
    };
    const decoder = this.options.codec.controlDecoder();
    let connection: Awaited<ReturnType<DaemonSocketClient["connect"]>> | undefined;
    try {
      connection = await this.options.sockets.connect(endpoint, this.options.responseTimeoutMs);
      connection.write(this.options.codec.encodeControl(acknowledgement));
      let responseReceived = false;
      for await (const bytes of connection.incoming) {
        for (const response of decoder.append(bytes)) {
          if (responseReceived) throw new Error("Duplicate daemon result acknowledgement");
          this.options.validator.resultAcknowledgement(request, transferId, response);
          responseReceived = true;
        }
        if (responseReceived) connection.end();
      }
      decoder.assertComplete();
      if (!responseReceived) throw new Error("Daemon acknowledgement response is missing");
      connection.destroy();
    } catch (error) {
      connection?.destroy();
      if (DaemonLifecycleClient.isSocketTimeout(error)) {
        throw new Error("Daemon result acknowledgement timed out");
      }
      throw error;
    }
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
    this.options.validator.request(request);
    const decoder = this.options.codec.controlDecoder();
    let connection: Awaited<ReturnType<DaemonSocketClient["connect"]>>;
    let delivery: DaemonDeliveryState = "not-submitted";
    try {
      connection = await this.options.sockets.connect(endpoint, this.options.responseTimeoutMs);
    } catch (error) {
      if (DaemonLifecycleClient.isSocketTimeout(error)) {
        throw new DaemonTransportError("timeout", delivery, "Daemon request timed out");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonTransportError("unreachable", delivery, message);
    }
    try {
      connection.write(this.options.codec.encodeControl(request));
      delivery = "submitted-unconfirmed";
    } catch (error) {
      connection.destroy();
      throw DaemonLifecycleClient.transportError(error, delivery);
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
              ? this.options.validator.executionStatusResponse(request, value)
              : this.options.validator.lifecycleResponse(request, value);
          delivery = "accepted";
          connection.end();
          return response;
        } catch (error) {
          throw DaemonLifecycleClient.transportError(error, delivery);
        }
      }
      try {
        decoder.assertComplete();
      } catch (error) {
        throw DaemonLifecycleClient.transportError(error, delivery);
      }
      throw new DaemonTransportError(
        "closed",
        delivery,
        "Daemon connection ended before a response",
      );
    } catch (error) {
      connection.destroy();
      if (DaemonLifecycleClient.isSocketTimeout(error)) {
        throw new DaemonTransportError("timeout", delivery, "Daemon request timed out");
      }
      if (!(error instanceof DaemonTransportError) && !(error instanceof DaemonProtocolError)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DaemonTransportError("closed", delivery, message);
      }
      throw DaemonLifecycleClient.transportError(error, delivery);
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
      (error as Error & { code?: string }).code === "ETIMEDOUT"
    );
  }
}
