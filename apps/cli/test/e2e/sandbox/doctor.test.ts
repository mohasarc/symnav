import type { AgentConfigurationLocations } from "../../../dist/agent-sandbox/agent-configuration.js";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { NodeUsageLogReader, usageLogPath } from "@symnav/telemetry";
import { CodexSandboxConfiguration } from "../../../dist/agent-sandbox/codex-configuration.js";
import { ClaudeCodeSandboxConfiguration } from "../../../dist/agent-sandbox/claude-code-configuration.js";
import { CodexSandboxRuntime } from "../../../dist/agent-sandbox/codex-runtime.js";
import { ClaudeCodeSandboxRuntime } from "../../../dist/agent-sandbox/claude-code-runtime.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";

class DoctorHarness {
  public static readonly roots: string[] = [];
  public static readonly probeStates: string[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-doctor-")));
  public readonly state = join(
    this.root,
    process.platform === "win32" ? "state 雪" : 'state 雪 "quoted"',
  );
  public readonly codex = join(this.root, "codex");
  public readonly claude = join(this.root, "claude");
  public readonly bin = join(this.root, "bin");
  public constructor() {
    DoctorHarness.roots.push(this.root);
    mkdirSync(this.bin);
    mkdirSync(this.codex);
    mkdirSync(this.claude);
  }
  public installed(name: string): void {
    const path = join(this.bin, process.platform === "win32" ? `${name}.EXE` : name);
    writeFileSync(path, "not an authenticated agent session");
    chmodSync(path, 0o700);
  }
  public configure(granted = true, denied = false): string {
    const path = join(this.claude, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        theme: "keep",
        sandbox: {
          enabled: false,
          filesystem: {
            allowWrite: granted ? [this.root] : [],
            denyWrite: denied ? [this.state] : [],
          },
        },
      }),
    );
    return path;
  }
  public runtimeEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: [
        this.bin,
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory)),
      ].join(delimiter),
    };
  }
  public run(argv: readonly string[], environment: NodeJS.ProcessEnv = {}) {
    return runSymnavBinary(argv, {
      cwd: this.root,
      env: {
        PATH: this.bin,
        CODEX_HOME: this.codex,
        CLAUDE_CONFIG_DIR: this.claude,
        SYMNAV_STATE_DIR: this.state,
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
        ...environment,
      },
    });
  }
}
afterEach(() => {
  for (const state of DoctorHarness.probeStates.splice(0))
    expect(new CliDaemonTesting(state).inspector.processLifetimeObservations()).not.toContain(
      "live",
    );
  for (const root of DoctorHarness.roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("symnav doctor", () => {
  it("prints deterministic padded skip lines and creates no retained state artifacts", () => {
    const h = new DoctorHarness();
    expect(h.run(["doctor"])).toEqual({
      status: 0,
      stderr: "",
      stdout: "codex        skip  not installed\nclaude-code  skip  not installed\n",
    });
    expect(readdirSync(h.state)).toEqual([]);
  });
  it("uses a custom Claude config root and original parent grant for truthful config-only output", () => {
    const h = new DoctorHarness();
    h.installed("claude");
    const path = h.configure();
    const original = readFileSync(path, "utf8");
    expect(h.run(["doctor", "claude-code"])).toEqual({
      status: 0,
      stderr: "",
      stdout: `claude-code  ok    configuration grants ${h.state}; live sandbox check skipped: ${process.platform === "win32" ? "sandbox runtime cannot be run from the command line" : "sandbox runtime not found"}\n`,
    });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(h.state)).toEqual([]);
    expect(existsSync(join(h.state, "usage.jsonl"))).toBe(false);
  });
  it.each([false, true])(
    "fails missing/denied grants even without live runtime: denied %s",
    (denied) => {
      const h = new DoctorHarness();
      h.installed("claude");
      h.configure(denied, denied);
      expect(h.run(["doctor", "claude-code"])).toEqual({
        status: 1,
        stderr: "",
        stdout: `claude-code  fail  sandbox denies write to ${h.state}; run 'symnav setup claude-code'\n`,
      });
    },
  );
  it.each([
    ["--no-warnings", "doctor", "claude-code"],
    ["doctor", "--no-warnings", "claude-code"],
    ["doctor", "claude-code", "--no-warnings"],
  ])("keeps diagnostic results with warning suppression: %s", (...argv) => {
    const h = new DoctorHarness();
    h.installed("claude");
    h.configure(false);
    const result = h.run(argv);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("claude-code  fail  sandbox denies write");
    expect(result).toEqual(h.run(["doctor", "claude-code"]));
  });
  it.each([
    ["doctor", "unknown"],
    ["doctor", "codex", "extra"],
    ["doctor", "codex", "claude-code"],
  ])("rejects invalid optional agent arguments: %s", (...argv) => {
    const h = new DoctorHarness();
    const result = h.run(argv);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(existsSync(h.state)).toBe(false);
  });
  it("reports doctor state write failure as an unsuppressed error", () => {
    const h = new DoctorHarness();
    writeFileSync(h.state, "");
    for (const argv of [["doctor"], ["doctor", "--no-warnings"]]) {
      const result = h.run(argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`symnav: error: cannot write ${h.state}`);
    }
  });
});

const supported = process.platform === "darwin" || process.platform === "linux";
const sandboxApplication =
  process.platform === "darwin"
    ? spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"])
    : process.platform === "linux"
      ? spawnSync("bwrap", ["--unshare-user", "--dev-bind", "/", "/", "true"])
      : undefined;
const sandboxApplicationAvailable = sandboxApplication?.status === 0;
const claudeRuntimeAvailable =
  supported &&
  sandboxApplicationAvailable &&
  spawnSync("srt", ["--version"], { encoding: "utf8" }).status === 0 &&
  (process.platform !== "linux" ||
    ["bwrap", "socat"].every((command) => spawnSync("which", [command]).status === 0));
const codexRuntimeAvailable =
  supported &&
  sandboxApplicationAvailable &&
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
if (process.env.SYMNAV_REQUIRE_SANDBOX_RUNTIME === "1" && !claudeRuntimeAvailable)
  throw new Error("Required doctor sandbox-runtime is unavailable");

describe.each([
  ["claude-code", claudeRuntimeAvailable],
  ["codex", codexRuntimeAvailable],
] as const)("actual %s doctor", (agent, available) => {
  it.skipIf(!available)(
    "proves warm navigation and leaves real config/usage unchanged with no scratch artifacts",
    () => {
      const h = new DoctorHarness();
      h.installed("claude");
      h.configure();
      writeFileSync(
        join(h.codex, "config.toml"),
        `sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(h.root)}]\n`,
      );
      mkdirSync(h.state);
      writeFileSync(join(h.state, "usage.jsonl"), "existing private usage\n");
      const config =
        agent === "codex" ? join(h.codex, "config.toml") : join(h.claude, "settings.json");
      const original = readFileSync(config, "utf8");
      expect(h.run(["doctor", agent], h.runtimeEnvironment())).toEqual({
        status: 0,
        stderr: "",
        stdout: `${agent.padEnd(13)}ok    daemon warm inside sandbox, telemetry recorded\n`,
      });
      expect(readFileSync(config, "utf8")).toBe(original);
      expect(readFileSync(join(h.state, "usage.jsonl"), "utf8")).toBe("existing private usage\n");
      expect(readdirSync(h.state)).toEqual(["usage.jsonl"]);
    },
    60000,
  );
  it.skipIf(!available)(
    "treats installed runtime proof rejection as failure and removes scratch artifacts",
    () => {
      const h = new DoctorHarness();
      h.installed("claude");
      h.configure();
      writeFileSync(
        join(h.claude, "settings.json"),
        JSON.stringify({
          sandbox: { filesystem: { allowWrite: [h.root], denyWrite: [join(h.state, "doctor")] } },
        }),
      );
      writeFileSync(
        join(h.codex, "config.toml"),
        `default_permissions="selected"\n[permissions.selected]\nextends=":read-only"\n[permissions.selected.filesystem]\n${JSON.stringify(h.root)}="write"\n${JSON.stringify(join(h.state, "doctor"))}="deny"\n`,
      );
      const result = h.run(["doctor", agent], h.runtimeEnvironment());
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`${agent.padEnd(13)}fail  `);
      expect(result.stdout).not.toContain("live sandbox check skipped");
      expect(readdirSync(h.state)).toEqual([]);
    },
    60000,
  );
  it.skipIf(!available)(
    "observes exited scratch lifetimes and actual cold/warm telemetry through production surfaces",
    async () => {
      const h = new DoctorHarness();
      const scratch = join(h.state, "doctor", "runtime-proof");
      const workspace = join(scratch, "workspace");
      const state = join(scratch, "probe-state");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(workspace, ".git"));
      writeFileSync(join(workspace, "tsconfig.json"), '{"include":["index.ts"]}');
      writeFileSync(join(workspace, "index.ts"), "export const doctorProbe=1;\n");
      writeFileSync(
        join(h.claude, "settings.json"),
        JSON.stringify({
          sandbox: {
            enabled: false,
            filesystem: { allowWrite: [h.root], denyWrite: [], denyRead: [] },
          },
        }),
      );
      writeFileSync(
        join(h.codex, "config.toml"),
        `sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(h.root)}]\n`,
      );
      const locations: AgentConfigurationLocations = {
        homeDirectory: h.root,
        codexHome: h.codex,
        claudeConfigurationDirectory: h.claude,
        workspaceDirectory: h.root,
      };
      const configuration =
        agent === "codex"
          ? new CodexSandboxConfiguration(locations)
          : new ClaudeCodeSandboxConfiguration(locations);
      DoctorHarness.probeStates.push(state);
      await (agent === "codex" ? new CodexSandboxRuntime() : new ClaudeCodeSandboxRuntime()).probe({
        scratchDirectory: scratch,
        workspace,
        stateDirectory: state,
        policy: await configuration.inspect(h.state, workspace),
      });
      expect(
        new NodeUsageLogReader().read(usageLogPath(state)).map((event) => event.executionMode),
      ).toEqual(["cold", "warm"]);
      const inspector = new CliDaemonTesting(state).inspector;
      expect(inspector.listInstances()).toEqual([]);
      const lifetimes = inspector.processLifetimeObservations();
      expect(lifetimes.length).toBeGreaterThan(0);
      expect(lifetimes.every((value) => value === "exited")).toBe(true);
    },
    60000,
  );
});
