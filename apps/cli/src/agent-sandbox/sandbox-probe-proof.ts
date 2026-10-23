import { setTimeout as pause } from "node:timers/promises";
import { NodeUsageLogReader, usageLogPath } from "@symnav/telemetry";
import type { SandboxProbeChannel } from "./sandbox-probe-channel.js";
import type { SandboxProbeReply } from "./sandbox-probe-message.js";
import { SandboxProbeCleanupError } from "./sandbox-probe-cleanup-error.js";

interface SandboxProbeProofOptions {
  readonly session: SandboxProbeChannel;
  readonly workspace: string;
  readonly stateDirectory: string;
  readonly cleanup: () => Promise<void>;
  readonly timeoutMs?: number;
}

export class SandboxProbeProof {
  public constructor(private readonly options: SandboxProbeProofOptions) {}

  public async run(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(
      () => controller.abort(new Error("sandbox probe timed out")),
      this.options.timeoutMs ?? 30_000,
    );
    let failure: unknown;
    try {
      controller.signal.throwIfAborted();
      await this.options.session.ready(controller.signal);
      const cold = this.command(
        await this.options.session.request({ action: "run" }, controller.signal),
      );
      await this.waitUntilReady(controller.signal);
      const warm = this.command(
        await this.options.session.request({ action: "run" }, controller.signal),
      );
      if (warm.stdout !== cold.stdout)
        throw new Error("sandbox warm output differs from cold output");
      const events = new NodeUsageLogReader().read(usageLogPath(this.options.stateDirectory));
      const commands = events.filter((event) => event.command === "overview");
      if (
        commands.length !== 2 ||
        commands[0]?.executionMode !== "cold" ||
        commands[1]?.executionMode !== "warm" ||
        commands.some((event) => event.outcome !== "success")
      )
        throw new Error("sandbox warm execution and telemetry were not recorded");
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      try {
        const cleanupFailure = await this.cleanup();
        if (failure === undefined && cleanupFailure !== undefined)
          failure = new Error(cleanupFailure);
      } catch (error) {
        throw new SandboxProbeCleanupError(
          `scratch cleanup could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    if (failure !== undefined) throw failure;
  }

  private command(reply: SandboxProbeReply): Extract<SandboxProbeReply, { kind: "command" }> {
    if (
      reply.kind !== "command" ||
      reply.exitCode !== 0 ||
      reply.stderr !== "" ||
      reply.stdout.trim() === ""
    )
      throw new Error("sandbox navigation command failed");
    return reply;
  }

  private async waitUntilReady(signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      const reply = await this.options.session.request({ action: "status" }, signal);
      if (reply.kind !== "status") throw new Error("sandbox daemon status failed");
      if (
        reply.report.startupFailures?.some(
          (failure) => failure.workspaceRoot === this.options.workspace,
        )
      )
        throw new Error("sandbox daemon warm-up failed");
      const daemon = reply.report.daemons.find(
        (daemon) => daemon.workspaceRoot === this.options.workspace,
      );
      if (daemon?.state === "ready") return;
      await pause(50, undefined, { signal });
    }
  }

  private async cleanup(): Promise<string | undefined> {
    let reportedFailure: string | undefined;
    try {
      const reply = await this.options.session.request({ action: "cleanup" });
      if (reply.kind === "cleaned") reportedFailure = reply.failure;
    } catch {
    } finally {
      try {
        await this.options.session.close();
      } finally {
        await this.options.cleanup();
      }
    }
    return reportedFailure;
  }
}
