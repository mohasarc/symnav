import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SandboxLaunchCommand } from "./sandbox-launch-command.js";
import type { SandboxProbeChannel } from "./sandbox-probe-channel.js";
import type { SandboxProbeMessage, SandboxProbeReply } from "./sandbox-probe-message.js";

interface PendingProbeReply {
  readonly resolve: (reply: SandboxProbeReply) => void;
  readonly reject: (error: unknown) => void;
}

export class SandboxProcessSession implements SandboxProbeChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, PendingProbeReply>();
  private readonly replies = new Map<number, SandboxProbeReply>();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private sequence = 0;
  private outputBytes = 0;

  public constructor(command: SandboxLaunchCommand) {
    this.child = spawn(command.executable, [...command.argv], {
      cwd: command.cwd,
      env: command.environment,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.fail(new Error("sandbox runtime exited"));
        resolve();
      }),
    );
    this.child.once("error", () => this.fail(new Error("sandbox runtime could not start")));
    this.child.stdin.on("error", () => this.fail(new Error("sandbox runtime input closed")));
    this.child.stderr.resume();
    this.child.stdout.on("data", (bytes: Buffer) => {
      this.outputBytes += bytes.length;
      if (this.outputBytes > 1024 * 1024)
        this.fail(new Error("sandbox runtime response exceeded probe limit"));
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
  }

  public async ready(signal: AbortSignal): Promise<void> {
    const reply = await this.next(0, signal);
    if (reply.kind !== "ready") throw new Error("sandbox runtime did not initialize the probe");
  }

  public request(
    message: SandboxProbeMessage,
    signal: AbortSignal = AbortSignal.timeout(8000),
  ): Promise<SandboxProbeReply> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const id = ++this.sequence;
    const response = this.next(id, signal);
    this.child.stdin.write(JSON.stringify({ id, message }) + "\n");
    return response;
  }

  public close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    this.child.stdin.end();
    if (await this.waitForExit(1000)) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    if (await this.waitForExit(8000)) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    if (!(await this.waitForExit(2000))) throw new Error("owned sandbox wrapper did not exit");
  }

  private async waitForExit(milliseconds: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private next(id: number, signal: AbortSignal): Promise<SandboxProbeReply> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (signal.aborted) return Promise.reject(signal.reason);
    const queued = this.replies.get(id);
    if (queued !== undefined) {
      this.replies.delete(id);
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal.reason);
      };
      const finish = (operation: () => void) => {
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
        operation();
      };
      this.pending.set(id, {
        resolve: (reply) => finish(() => resolve(reply)),
        reject: (error) => finish(() => reject(error)),
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private receive(line: string): void {
    if (this.failure !== undefined) return;
    try {
      const message = JSON.parse(line) as { id: number; reply: SandboxProbeReply };
      if (
        !Number.isInteger(message.id) ||
        typeof message.reply !== "object" ||
        message.reply === null
      )
        throw new Error("invalid envelope");
      const pending = this.pending.get(message.id);
      if (pending === undefined) this.replies.set(message.id, message.reply);
      else pending.resolve(message.reply);
    } catch {
      this.fail(new Error("sandbox runtime emitted an invalid probe response"));
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of [...this.pending.values()]) pending.reject(this.failure);
    this.pending.clear();
  }
}
