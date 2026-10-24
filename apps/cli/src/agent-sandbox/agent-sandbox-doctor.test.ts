import * as filesystem from "node:fs/promises";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentExecutable } from "./agent-executable.js";
import { CodexSandboxConfiguration } from "./codex-configuration.js";
import { ClaudeCodeSandboxConfiguration } from "./claude-code-configuration.js";
import { AgentSandboxRuntime, type SandboxProbeRequest } from "./agent-sandbox-runtime.js";
import { AgentSandboxDoctor } from "./agent-sandbox-doctor.js";
import { SandboxProbeStartupError } from "./sandbox-probe-startup-error.js";
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
  const probe = h.runtimes[0]!.calls[0]!;
  expect(basename(probe.stateDirectory)).toBe("probe-state");
  expect(basename(probe.workspace)).toBe("workspace");
  expect(dirname(probe.stateDirectory)).toBe(probe.scratchDirectory);
  expect(dirname(probe.workspace)).toBe(probe.scratchDirectory);
  expect(dirname(probe.scratchDirectory)).toBe(join(h.root, "doctor"));
  expect(probe.stateDirectory).not.toBe(probe.workspace);
  expect(await readdir(h.root)).toEqual([]);
});
it.each([undefined, "ENOENT"])(
  "reports recorded startup fields without inventing a cause with OS code %s",
  async (osCode) => {
    const h = await Harness.create();
    vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
    h.runtimes[1]!.available = "available";
    h.runtimes[1]!.failure = new SandboxProbeStartupError({
      workspaceRoot: "/observed-workspace",
      failure: {
        phase: "process spawn",
        reason: "process-spawn-failed",
        timestamp: 42,
        ...(osCode === undefined ? {} : { osCode }),
      },
    });
    expect(await h.doctor().doctor.check("claude-code")).toEqual([
      {
        agent: "claude-code",
        status: "fail",
        reason: `sandbox daemon warm-up failed (phase: process spawn; reason: process-spawn-failed${osCode === undefined ? "" : `; OS code: ${osCode}`}; workspace: /observed-workspace); investigate the reported startup failure and rerun doctor`,
      },
    ]);
    expect(await readdir(h.root)).toEqual([]);
  },
);
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
it("leaves concurrent doctor scratch and ordinary state untouched", async () => {
  const h = await Harness.create();
  const other = join(h.root, "doctor", "other");
  await filesystem.mkdir(other, { recursive: true });
  await writeFile(join(other, "marker"), "keep");
  await writeFile(join(h.root, "usage.jsonl"), "private usage");
  vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
  h.runtimes[0]!.available = "available";
  expect(await h.doctor().doctor.check("codex")).toEqual([
    { agent: "codex", status: "ok", check: "live" },
  ]);
  expect(await readdir(join(h.root, "doctor"))).toEqual(["other"]);
  expect(await filesystem.readFile(join(other, "marker"), "utf8")).toBe("keep");
  expect(await filesystem.readFile(join(h.root, "usage.jsonl"), "utf8")).toBe("private usage");
});
it.each(["available", "not-found"] as const)(
  "fails unsupported patterned state denial before %s runtime selection",
  async (availability) => {
    const h = await Harness.create();
    vi.spyOn(AgentExecutable, "installed").mockResolvedValue(true);
    const parent = join(h.root, "states");
    const state = join(parent, "private", "state");
    await filesystem.mkdir(state, { recursive: true });
    await filesystem.mkdir(join(h.root, ".codex"));
    const configuration = new CodexSandboxConfiguration({ homeDirectory: h.root });
    await writeFile(
      configuration.configurationPath,
      `default_permissions="selected"\n[permissions.selected]\nextends=":read-only"\n[permissions.selected.filesystem]\n${JSON.stringify(parent)}={ "."="write", "*/state"="deny" }\n`,
    );
    h.runtimes[0]!.available = availability;
    const runtimeAvailability = vi.spyOn(h.runtimes[0]!, "availability");
    const doctor = new AgentSandboxDoctor({
      stateDirectory: state,
      configurations: [configuration],
      runtimes: h.runtimes,
    });
    expect(await doctor.check("codex")).toEqual([
      {
        agent: "codex",
        status: "fail",
        reason: expect.stringContaining("cannot verify patterned Codex state denial"),
      },
    ]);
    expect(runtimeAvailability).not.toHaveBeenCalled();
    expect(h.runtimes[0]!.calls).toEqual([]);
  },
);
