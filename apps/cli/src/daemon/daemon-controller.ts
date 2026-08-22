import type { DaemonRegistry } from "./daemon-registry.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

export class DaemonController {
  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
    private readonly stateDirectory: string,
  ) {}
}
