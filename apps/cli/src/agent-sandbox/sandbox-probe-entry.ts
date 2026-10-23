import { createInterface } from "node:readline";
import { createWorkspace } from "@symnav/core";
import { DaemonPolicy } from "@symnav/daemon";
import { CliInvocationCoordinator } from "../cli-invocation-coordinator.js";
import { CliInvocationRunner } from "../cli-invocation-runner.js";
import { CliProgramExecutor } from "../cli-program-executor.js";
import { createDefaultDependencies } from "../program.js";
import { SandboxProbeActor } from "./sandbox-probe-actor.js";
import type { SandboxProbeMessage, SandboxProbeReply } from "./sandbox-probe-message.js";

class SandboxProbeEntry {
  public static async main(): Promise<void> {
    const stateDirectory = process.env.SYMNAV_STATE_DIR;
    if (stateDirectory === undefined) throw new Error("probe state is missing");
    const dependencies = createDefaultDependencies(
      stateDirectory,
      DaemonPolicy.currentSystem(),
      true,
    );
    const coordinator = new CliInvocationCoordinator({
      daemonClient: dependencies.daemonClient,
      createLocalExecutor: () => new CliProgramExecutor(dependencies),
      resolveWorkspaceRoot: async (startDirectory) =>
        (await createWorkspace({ startDir: startDirectory, fs: dependencies.fs })).root,
    });
    const actor = new SandboxProbeActor(
      dependencies,
      new CliInvocationRunner({ dependencies, coordinator }),
      process.cwd(),
    );
    const interrupted = () => {
      void actor.cleanup().then(
        () => process.exit(1),
        () => process.exit(2),
      );
    };
    process.on("SIGTERM", interrupted);
    process.on("SIGINT", interrupted);
    const input = createInterface({ input: process.stdin });
    this.reply(0, { kind: "ready" });
    try {
      for await (const line of input) {
        const request = JSON.parse(line) as { id: number; message: SandboxProbeMessage };
        try {
          this.reply(request.id, await actor.handle(request.message));
        } catch (error) {
          this.reply(request.id, {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await actor.cleanup();
      process.off("SIGTERM", interrupted);
      process.off("SIGINT", interrupted);
    }
  }
  private static reply(id: number, reply: SandboxProbeReply): void {
    process.stdout.write(JSON.stringify({ id, reply }) + "\n");
  }
}
await SandboxProbeEntry.main();
