import type { DaemonPolicyValues } from "@symnav/daemon";
import { DaemonClientResultCapture } from "./daemon-client-result-capture.js";
import { DaemonExecutionClient } from "./daemon-execution-client.js";
import { DaemonLifecycleClient } from "./daemon-lifecycle-client.js";
import type {
  DaemonExecuteRequest,
  DaemonExecutionStatusRequest,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonServer,
} from "./daemon-protocol.js";
import { DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import type {
  DaemonExecutionReceipt,
  DaemonExecutionRequester,
  DaemonLifecycleRequester,
  DaemonRequestHandler,
  DaemonRequestServer,
  DaemonSocketClient,
} from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { LocalDaemonSocketClient } from "./local-daemon-socket-client.js";
import { LocalDaemonSocketServer } from "./local-daemon-socket-server.js";

interface LocalDaemonTransportOptions {
  readonly lifecycleResponseTimeoutMs?: number;
  readonly writeChunkSize?: number;
  readonly outputDirectory?: string;
  readonly sockets?: DaemonSocketClient;
  readonly lifecycle?: DaemonLifecycleComponent;
  readonly execution?: DaemonExecutionRequester;
  readonly server?: DaemonRequestServer;
}

type DaemonLifecycleComponent = DaemonLifecycleRequester &
  Pick<DaemonLifecycleClient, "acknowledgeResult">;

export type LocalDaemonTransportPolicy = Pick<
  DaemonPolicyValues,
  "transport" | "delivery" | "output"
>;

export class LocalDaemonTransport
  implements DaemonLifecycleRequester, DaemonExecutionRequester, DaemonRequestServer
{
  private readonly codec: DaemonWireCodec;
  private readonly validator = new DaemonProtocolValidator();
  private readonly sockets: DaemonSocketClient;
  private readonly lifecycle: DaemonLifecycleClient;
  private readonly execution: DaemonExecutionRequester;
  private readonly server: DaemonRequestServer;

  constructor(policy: LocalDaemonTransportPolicy, options: LocalDaemonTransportOptions = {}) {
    this.codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes: policy.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
    });
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
    this.execution = new DaemonExecutionClient({
      sockets: this.sockets,
      lifecycle: this.lifecycle,
      codec: this.codec,
      validator: this.validator,
      createOutput: () =>
        new DaemonClientResultCapture({
          policy: policy.output,
          ...(options.outputDirectory === undefined ? {} : { directory: options.outputDirectory }),
        }),
      transportPolicy: policy.transport,
      deliveryPolicy: policy.delivery,
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
    return this.execution.execute(endpoint, request);
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
}
