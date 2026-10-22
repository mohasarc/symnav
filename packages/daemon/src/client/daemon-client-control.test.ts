import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonExecutor } from "@symnav/daemon";
import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonController } from "../process/controller.js";
import { DaemonClientRuntime as DaemonClient } from "./daemon-client-runtime.js";

describe("DaemonClient control", () => {
  afterEach(() => vi.restoreAllMocks());

  it("owns one start/status/stop composition with distinct response timeouts", async () => {
    const policy = DaemonPolicy.currentSystem();
    const client = createClient(policy);
    const composition = ClientControlInspection.read(client);
    const start = vi.spyOn(DaemonController.prototype, "start").mockResolvedValue({
      status: "ready",
      workspaceRoot: "/workspace",
      fileCount: 4,
      loadDurationMs: 2,
    });
    const status = vi.spyOn(DaemonController.prototype, "status").mockResolvedValue([]);
    const stop = vi
      .spyOn(DaemonController.prototype, "stop")
      .mockResolvedValue({ status: "not-running", workspaceRoot: "/workspace" });

    await client.control({ action: "start", workspaceRoot: "/workspace" });
    await client.control({ action: "status" });
    await client.control({ action: "stop", workspaceRoot: "/workspace" });
    await client.control({ action: "status" });

    expect(start).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(ClientControlInspection.read(client)).toEqual(composition);
    expect(ClientControlInspection.responseTimeout(composition.routingTransport)).toBe(
      policy.values.transport.singleResponseTimeoutMs,
    );
    expect(ClientControlInspection.responseTimeout(composition.statusTransport)).toBe(
      policy.values.transport.statusResponseTimeoutMs,
    );
  });

  it("returns disabled start without invoking lifecycle mechanisms", async () => {
    const start = vi.spyOn(DaemonController.prototype, "start");
    const client = createClient(DaemonPolicy.currentSystem(), false);

    await expect(client.control({ action: "start", workspaceRoot: "/workspace" })).resolves.toEqual(
      { status: "disabled" },
    );

    expect(start).not.toHaveBeenCalled();
  });

  it.each(["start", "status", "stop"] as const)(
    "rejects %s mechanism errors for the host wrapper",
    async (action) => {
      vi.spyOn(DaemonController.prototype, action).mockRejectedValue(new Error(`${action} failed`));
      const client = createClient(DaemonPolicy.currentSystem());

      if (action === "status") {
        await expect(client.control({ action })).rejects.toThrow(`${action} failed`);
      } else if (action === "start") {
        await expect(client.control({ action, workspaceRoot: "/workspace" })).rejects.toThrow(
          `${action} failed`,
        );
      } else {
        await expect(client.control({ action, workspaceRoot: "/workspace" })).rejects.toThrow(
          `${action} failed`,
        );
      }
    },
  );
});

class ClientControlInspection {
  static read(client: DaemonClient): {
    readonly routingTransport: object;
    readonly statusTransport: object;
    readonly controlController: DaemonController;
    readonly statusController: DaemonController;
  } {
    return client as unknown as ReturnType<typeof ClientControlInspection.read>;
  }

  static responseTimeout(transport: object): number {
    const composition = transport as unknown as {
      readonly lifecycle: { readonly options: { readonly responseTimeoutMs: number } };
    };
    return composition.lifecycle.options.responseTimeoutMs;
  }
}

function createClient(policy: DaemonPolicy, daemonEnabled = true): DaemonClient {
  return new DaemonClient({
    stateDirectory: "/state",
    productVersion: "0.1.0",
    daemonEnabled,
    executorFactory: () => localExecutor(),
    executorModuleUrl: "file:///executor.js",
    readinessProbe: { commandName: "version", argv: ["--version"] },
    policy,
  });
}

function localExecutor(): DaemonExecutor {
  return {
    initialize: async () => ({ fileCount: 0 }),
    execute: async () => {
      throw new Error("Local execution was not expected");
    },
    releaseTransientResources: async () => undefined,
  };
}
