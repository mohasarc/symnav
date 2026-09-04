import type {
  DaemonExecutionStatus,
  DaemonExecutionStatusRequest,
  DaemonExecutionStatusResponse,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
} from "./daemon-protocol.js";
import { DaemonProtocolError, type DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import { DaemonTransportError, type DaemonDeliveryState } from "./daemon-transport-error.js";
import type { DaemonLifecycleRequester, DaemonSocketClient } from "./daemon-transport.js";
import type { DaemonWireCodec } from "./daemon-wire-codec.js";

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
          delivery = "accepted";
          const response =
            request.kind === "execution-status"
              ? this.options.validator.executionStatusResponse(request, value)
              : this.options.validator.lifecycleResponse(request, value);
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
        delivery,
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
