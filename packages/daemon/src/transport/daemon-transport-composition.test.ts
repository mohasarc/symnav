import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonClientResultCapture } from "./client-result-capture.js";
import { DaemonExecutionClient } from "./execution-client.js";
import { DaemonLifecycleClient } from "./lifecycle-client.js";
import { DaemonTransportFactory } from "./daemon-transport.js";
import { LocalDaemonSocketServer } from "./socket-server.js";

describe("DaemonTransportFactory", () => {
  it("creates the three focused transport owners from one policy", () => {
    const policy = DaemonPolicy.currentSystem();
    const components = DaemonTransportFactory.create({ policy, captureDirectory: "/capture" });

    expect(components.lifecycle).toBeInstanceOf(DaemonLifecycleClient);
    expect(components.execution).toBeInstanceOf(DaemonExecutionClient);
    expect(components.server).toBeInstanceOf(LocalDaemonSocketServer);
    const execution = components.execution as unknown as {
      readonly options: { readonly createOutput: () => unknown };
    };
    expect(execution.options.createOutput()).toBeInstanceOf(DaemonClientResultCapture);
  });

  it("preserves explicitly injected focused owners", () => {
    const defaults = DaemonTransportFactory.create({ policy: DaemonPolicy.currentSystem() });
    const components = DaemonTransportFactory.create({
      policy: DaemonPolicy.currentSystem(),
      lifecycle: defaults.lifecycle,
      execution: defaults.execution,
      server: defaults.server,
    });

    expect(components).toEqual(defaults);
  });
});
