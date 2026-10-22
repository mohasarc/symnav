import type { DaemonServerMessage } from "./protocol.js";
import type { DaemonRequestHandler, DaemonServerSend } from "./contracts.js";
import type { DaemonWireCodec } from "./wire-codec.js";
import type { DaemonProtocolValidator } from "./protocol-validator.js";

interface DaemonRequestDispatcherOptions {
  readonly codec: DaemonWireCodec;
  readonly validator: DaemonProtocolValidator;
  readonly handler: DaemonRequestHandler;
  readonly write: (frame: Uint8Array) => Promise<void>;
  readonly destroy: () => void;
}

export class DaemonRequestDispatcher {
  private readonly decoder;
  private responses = Promise.resolve();
  private writes = Promise.resolve();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private readonly send: DaemonServerSend;

  public constructor(private readonly options: DaemonRequestDispatcherOptions) {
    this.decoder = options.codec.controlDecoder();
    this.send = Object.assign(
      (message: DaemonServerMessage): Promise<void> => {
        const write = this.writes.then(() =>
          options.write(options.codec.encodeServerMessage(message)),
        );
        this.writes = write;
        return write;
      },
      {
        onClose: (listener: () => void): (() => void) => {
          if (this.closed) {
            listener();
            return () => {};
          }
          this.closeListeners.add(listener);
          return () => {
            this.closeListeners.delete(listener);
          };
        },
      },
    );
  }

  public receive(bytes: Uint8Array): void {
    try {
      for (const value of this.decoder.append(bytes)) {
        const request = this.options.validator.request(value);
        this.responses = this.responses
          .then(async () => {
            const response = await this.options.handler(request, this.send);
            if (response !== undefined) await this.send(response);
          })
          .catch(() => this.options.destroy());
      }
    } catch {
      this.options.destroy();
    }
  }

  public end(): void {
    try {
      this.decoder.assertComplete();
    } catch {
      this.options.destroy();
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {}
    }
    this.closeListeners.clear();
  }
}
