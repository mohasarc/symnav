import type { DaemonPolicy } from "../daemon-policy.js";
import { DaemonClientResultCapture, type DaemonOutputCapture } from "./client-result-capture.js";
import { DaemonExecutionClient } from "./execution-client.js";
import { DaemonLifecycleClient } from "./lifecycle-client.js";
import { DaemonProtocolValidator } from "./protocol-validator.js";
import type { DaemonRequestServer, DaemonSocketClient } from "./contracts.js";
import { DaemonWireCodec } from "./wire-codec.js";
import { LocalDaemonSocketClient } from "./socket-client.js";
import { LocalDaemonSocketServer } from "./socket-server.js";

export interface DaemonTransportOptions {
  readonly policy: DaemonPolicy;
  readonly lifecycleResponseTimeoutMs?: number;
  readonly writeChunkSize?: number;
  readonly captureDirectory?: string;
  readonly codec?: DaemonWireCodec;
  readonly validator?: DaemonProtocolValidator;
  readonly sockets?: DaemonSocketClient;
  readonly lifecycle?: DaemonLifecycleClient;
  readonly execution?: DaemonExecutionClient;
  readonly server?: DaemonRequestServer;
  readonly createOutput?: () => DaemonOutputCapture;
}

export interface DaemonTransportComponents {
  readonly lifecycle: DaemonLifecycleClient;
  readonly execution: DaemonExecutionClient;
  readonly server: DaemonRequestServer;
}

export class DaemonTransportFactory {
  static create(options: DaemonTransportOptions): DaemonTransportComponents {
    const policy = options.policy;
    const codec =
      options.codec ??
      new DaemonWireCodec({
        maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
        maximumExecutionControlPayloadBytes:
          policy.values.transport.maximumExecutionControlPayloadBytes,
        maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
      });
    const validator = options.validator ?? new DaemonProtocolValidator();
    const sockets =
      options.sockets ??
      new LocalDaemonSocketClient(
        options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize },
      );
    const lifecycle =
      options.lifecycle ??
      new DaemonLifecycleClient({
        sockets,
        codec,
        validator,
        responseTimeoutMs:
          options.lifecycleResponseTimeoutMs ?? policy.values.transport.singleResponseTimeoutMs,
      });
    const execution =
      options.execution ??
      new DaemonExecutionClient({
        sockets,
        lifecycle,
        codec,
        validator,
        createOutput:
          options.createOutput ??
          (() =>
            new DaemonClientResultCapture({
              policy: policy.values.output,
              ...(options.captureDirectory === undefined
                ? {}
                : { directory: options.captureDirectory }),
            })),
        transportPolicy: policy.values.transport,
        deliveryPolicy: policy.values.delivery,
      });
    const server =
      options.server ??
      new LocalDaemonSocketServer({
        sockets,
        codec,
        validator,
        policy: policy.values.transport,
        ...(options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize }),
      });
    return { lifecycle, execution, server };
  }
}
