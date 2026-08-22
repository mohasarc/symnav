import type { DaemonRegistry } from "./daemon-registry.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

interface DaemonControllerOptions {
  readonly processTerminator?: DaemonProcessTerminator;
}

export class DaemonController {
  private readonly processTerminator: DaemonProcessTerminator;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
    private readonly stateDirectory: string,
    options: DaemonControllerOptions = {},
  ) {
    this.processTerminator = options.processTerminator ?? new NodeDaemonProcessTerminator();
  }
}
