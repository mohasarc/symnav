import { Writable } from "node:stream";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { CliInvocationRunner } from "../cli-invocation-runner.js";
import type { SandboxProbeMessage, SandboxProbeReply } from "./sandbox-probe-message.js";

export class SandboxProbeActor {
  private cleaning: Promise<SandboxProbeReply> | undefined;
  public constructor(
    private readonly dependencies: ProgramDependencies,
    private readonly runner: Pick<CliInvocationRunner, "run">,
    private readonly workspace: string,
  ) {}

  public async handle(message: SandboxProbeMessage): Promise<SandboxProbeReply> {
    if (message.action === "cleanup") return this.cleanup();
    if (this.cleaning !== undefined) throw new Error("probe is stopping");
    if (message.action === "status")
      return {
        kind: "status",
        report: await this.dependencies.daemonClient.control({ action: "status" }),
      };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const exitCode = await this.runner.run(
      {
        argv: ["overview", "index.ts"],
        cwd: this.workspace,
        telemetryEnabled: true,
        executionMode: "cold",
      },
      {
        cwd: this.workspace,
        stdout: this.output(stdout),
        stderr: this.output(stderr),
        exit: (code) => {
          throw new Error(`probe command exited ${code}`);
        },
      },
    );
    return {
      kind: "command",
      exitCode,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  }

  public cleanup(): Promise<SandboxProbeReply> {
    this.cleaning ??= this.finish();
    return this.cleaning;
  }

  private async finish(): Promise<SandboxProbeReply> {
    let failure: string | undefined;
    try {
      await this.dependencies.daemonClient.control({
        action: "stop",
        workspaceRoot: this.workspace,
      });
    } catch (error) {
      failure = `scratch daemon stop failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.dependencies.daemonClient.closeOwnedProcesses();
    return { kind: "cleaned", ...(failure === undefined ? {} : { failure }) };
  }

  private output(chunks: Buffer[]): Writable {
    return new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(bytes));
        callback();
      },
    });
  }
}
