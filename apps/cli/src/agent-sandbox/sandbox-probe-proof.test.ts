import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NodeUsageLogReader, SCHEMA_VERSION, type UsageEvent } from "@symnav/telemetry";
import type { SandboxProbeMessage, SandboxProbeReply } from "./sandbox-probe-message.js";
import type { SandboxProbeChannel } from "./sandbox-probe-channel.js";
import { SandboxProbeProof } from "./sandbox-probe-proof.js";

class Channel implements SandboxProbeChannel {
  public readonly actions: string[] = [];
  public failure: string | undefined;
  public ready = vi.fn(async () => {
    if (this.failure === "runtime") throw new Error("runtime rejected policy");
  });
  public close = vi.fn(async () => {});
  private runs = 0;
  public async request(message: SandboxProbeMessage): Promise<SandboxProbeReply> {
    this.actions.push(message.action);
    if (message.action === "cleanup")
      return { kind: "cleaned", ...(this.failure === "stop" ? { failure: "stop failed" } : {}) };
    if (message.action === "status")
      return {
        kind: "status",
        report:
          this.failure === "warmup"
            ? {
                daemons: [],
                startupFailures: [
                  {
                    workspaceRoot: "/workspace",
                    failure: { phase: "warm-up", timestamp: 1, reason: "startup-failed" },
                  },
                ],
              }
            : {
                daemons: [
                  {
                    workspaceRoot: "/workspace",
                    state: "ready",
                    pid: 1,
                    uptimeMs: 1,
                    fileCount: 1,
                    memoryBytes: 1,
                  },
                ],
              },
      } as SandboxProbeReply;
    this.runs++;
    return {
      kind: "command",
      exitCode: this.failure === "command" ? 1 : 0,
      stdout: this.failure === "parity" && this.runs > 1 ? "different" : "proof",
      stderr: "",
    };
  }
}
class Harness {
  public static readonly roots: string[] = [];
  public channel = new Channel();
  public cleanup = vi.fn(async () => {});
  public constructor(public state: string) {
    Harness.roots.push(state);
  }
  public static async create() {
    return new Harness(await mkdtemp(join(tmpdir(), "probe-proof-")));
  }
  public proof() {
    return new SandboxProbeProof({
      session: this.channel,
      stateDirectory: this.state,
      workspace: "/workspace",
      cleanup: this.cleanup,
      timeoutMs: 100,
    });
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    Harness.roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("requires successful cold/warm output and actual warm telemetry before cleanup", async () => {
  const h = await Harness.create();
  const events: readonly UsageEvent[] = (["cold", "warm"] as const).map((executionMode) => ({
    schemaVersion: SCHEMA_VERSION,
    sessionId: "session",
    symnavVersion: "test",
    timestamp: 1,
    durationMs: 1,
    argShape: { kind: "path", lengthBucket: "short", flags: [] },
    workspaceId: "workspace",
    machineId: "machine",
    command: "overview",
    outcome: "success",
    executionMode,
  }));
  vi.spyOn(NodeUsageLogReader.prototype, "read").mockReturnValue(events);
  await h.proof().run();
  expect(h.channel.actions).toEqual(["run", "status", "run", "cleanup"]);
  expect(h.channel.close).toHaveBeenCalledOnce();
  expect(h.cleanup).toHaveBeenCalledOnce();
});
it.each(["runtime", "command", "warmup", "parity", "telemetry", "stop"])(
  "fails %s proof and always waits for wrapper/daemon cleanup",
  async (failure) => {
    const h = await Harness.create();
    h.channel.failure = failure;
    vi.spyOn(NodeUsageLogReader.prototype, "read").mockReturnValue([]);
    await expect(h.proof().run()).rejects.toThrow();
    expect(h.channel.actions.at(-1)).toBe("cleanup");
    expect(h.channel.close).toHaveBeenCalledOnce();
    expect(h.cleanup).toHaveBeenCalledOnce();
  },
);
it("cancels a probe and still cleans its owned work", async () => {
  const h = await Harness.create();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(h.proof().run(controller.signal)).rejects.toThrow("cancelled");
  expect(h.channel.close).toHaveBeenCalledOnce();
  expect(h.cleanup).toHaveBeenCalledOnce();
});
