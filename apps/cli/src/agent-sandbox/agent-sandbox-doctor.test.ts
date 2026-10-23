import * as filesystem from "node:fs/promises";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentExecutable } from "./agent-executable.js";
import { CodexSandboxConfiguration } from "./codex-configuration.js";
import { ClaudeCodeSandboxConfiguration } from "./claude-code-configuration.js";
import { AgentSandboxRuntime, type SandboxProbeRequest } from "./agent-sandbox-runtime.js";
import { AgentSandboxDoctor } from "./agent-sandbox-doctor.js";
import type { SupportedAgent } from "./agent-configuration.js";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, mkdir: vi.fn(module.mkdir) };
});

class Runtime extends AgentSandboxRuntime {
  public calls: SandboxProbeRequest[] = [];
  public available: "available" | "not-found" = "not-found";
  public failure: Error | undefined;
  public constructor(public readonly agent: SupportedAgent) {
    super();
  }
  public async availability() {
    return this.available;
  }
  public async probe(request: SandboxProbeRequest) {
    this.calls.push(request);
    if (this.failure) throw this.failure;
  }
}
class Harness {
  public static readonly roots: string[] = [];
  public readonly runtimes = [new Runtime("codex"), new Runtime("claude-code")];
  public constructor(public readonly root: string) {
    Harness.roots.push(root);
  }
  public static async create() {
    return new Harness(await mkdtemp(join(tmpdir(), "doctor-")));
  }
  public doctor() {
    const configurations = [
      new CodexSandboxConfiguration({ homeDirectory: this.root }),
      new ClaudeCodeSandboxConfiguration({ homeDirectory: this.root }),
    ];
    for (const configuration of configurations)
      vi.spyOn(configuration, "inspect").mockResolvedValue({
        grantsState: true,
        configuration: "policy",
      });
    return {
      doctor: new AgentSandboxDoctor({
        stateDirectory: this.root,
        configurations,
        runtimes: this.runtimes,
      }),
      configurations,
    };
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    Harness.roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("orders absent agents deterministically and leaves no doctor scratch", async () => {
  const h = await Harness.create();
  vi.spyOn(AgentExecutable, "installed").mockResolvedValue(false);
  expect(await h.doctor().doctor.check()).toEqual([
    { agent: "codex", status: "skip", reason: "not installed" },
    { agent: "claude-code", status: "skip", reason: "not installed" },
  ]);
  expect(await readdir(h.root)).toEqual([]);
});
it("checks the grant before unavailable runtime and supports a single agent", async () => {
  const h = await Harness.create();
  vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
  const { doctor, configurations } = h.doctor();
  vi.mocked(configurations[1]!.inspect).mockResolvedValue({
    grantsState: false,
    configuration: "policy",
  });
  expect(await doctor.check("claude-code")).toEqual([
    {
      agent: "claude-code",
      status: "fail",
      reason: `sandbox denies write to ${h.root}; run 'symnav setup claude-code'`,
    },
  ]);
  expect(configurations[0]!.inspect).not.toHaveBeenCalled();
  vi.mocked(configurations[1]!.inspect).mockResolvedValue({
    grantsState: true,
    configuration: "policy",
  });
  expect(await doctor.check("claude-code")).toEqual([
    {
      agent: "claude-code",
      status: "ok",
      check: "configuration",
      skippedReason: "sandbox runtime not found",
    },
  ]);
  expect(await readdir(h.root)).toEqual([]);
});
it("keeps installed runtime failures as failures and isolates each live probe", async () => {
  const h = await Harness.create();
  vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
  h.runtimes[0]!.available = "available";
  h.runtimes[0]!.failure = new Error("warm telemetry missing");
  const { doctor } = h.doctor();
  expect(await doctor.check("codex")).toEqual([
    {
      agent: "codex",
      status: "fail",
      reason: "warm telemetry missing; check sandbox policy and restart the agent session",
    },
  ]);
  expect(h.runtimes[0]!.calls[0]!.stateDirectory).toMatch(/doctor\/.+\/probe-state$/);
  expect(h.runtimes[0]!.calls[0]!.workspace).toMatch(/doctor\/.+\/workspace$/);
  expect(await readdir(h.root)).toEqual([]);
});
it("errors if doctor cannot write selected state", async () => {
  const h = await Harness.create();
  const state = join(h.root, "file");
  await writeFile(state, "");
  await expect(
    new AgentSandboxDoctor({ stateDirectory: state, configurations: [], runtimes: [] }).check(),
  ).rejects.toThrow("cannot write");
});
it("inspects original configuration before the host creates any scratch directories", async () => {
  const h = await Harness.create();
  vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
  const { doctor, configurations } = h.doctor();
  const writes = vi.mocked(filesystem.mkdir);
  writes.mockClear();
  vi.mocked(configurations[0]!.inspect).mockImplementation(async () => {
    expect(writes).not.toHaveBeenCalled();
    expect(await readdir(h.root)).toEqual([]);
    return { grantsState: true, configuration: "policy" };
  });
  expect(await doctor.check("codex")).toMatchObject([{ status: "ok", check: "configuration" }]);
});
it("retains only its own scratch when owned process exit cannot be confirmed", async () => {
  const { SandboxProbeCleanupError } = await import("./sandbox-probe-cleanup-error.js");
  const h = await Harness.create();
  vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
  h.runtimes[0]!.available = "available";
  h.runtimes[0]!.failure = new SandboxProbeCleanupError("owned wrapper did not exit");
  const { doctor } = h.doctor();
  expect(await doctor.check("codex")).toMatchObject([{ status: "fail" }]);
  const scratch = h.runtimes[0]!.calls[0]!.scratchDirectory;
  expect(await readdir(scratch)).toContain("workspace");
});
