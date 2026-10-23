import type { AgentProbePolicy } from "./agent-probe-policy.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexSandboxRuntime } from "./codex-runtime.js";
import { AgentExecutable } from "./agent-executable.js";
import type { SandboxProbeRequest } from "./agent-sandbox-runtime.js";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: execute,
}));
class Runtime extends CodexSandboxRuntime {
  public launch(request: SandboxProbeRequest) {
    return this.command(request);
  }
}
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it.each(["--permission-profile", "--permissions-profile"])(
  "uses recognized Codex %s help and minimal scratch policy",
  async (flag) => {
    const root = await mkdtemp(join(tmpdir(), "codex-launch-"));
    roots.push(root);
    vi.spyOn(AgentExecutable, "find").mockResolvedValue("/runtime/codex");
    execute.mockImplementation((_executable, _args, _options, callback) =>
      callback(null, `Usage: codex sandbox [OPTIONS] [COMMAND]...\n${flag} <NAME>`),
    );
    vi.stubEnv("OPENAI_API_KEY", "private");
    vi.stubEnv("NODE_OPTIONS", "private-loader");
    const policy: AgentProbePolicy = {
      grantsState: true,
      configuration: 'default_permissions="symnav-doctor"\n',
    };
    const command = await new Runtime().launch({
      scratchDirectory: root,
      workspace: join(root, "workspace"),
      stateDirectory: join(root, "probe-state"),
      policy,
    });
    expect(command.argv).toEqual([
      "sandbox",
      flag,
      "symnav-doctor",
      "-C",
      join(root, "workspace"),
      "--",
      process.execPath,
      expect.stringContaining("sandbox-probe-entry.js"),
    ]);
    expect(command.environment.OPENAI_API_KEY).toBeUndefined();
    expect(command.environment.NODE_OPTIONS).toBeUndefined();
    expect(await readFile(join(root, "codex", "config.toml"), "utf8")).toBe(policy.configuration);
  },
);
it("fails an installed but rejecting runtime without classifying it unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-reject-"));
  roots.push(root);
  vi.spyOn(AgentExecutable, "find").mockResolvedValue("/runtime/codex");
  execute.mockImplementation((_exe, _args, _options, callback) =>
    callback(new Error("rejected"), ""),
  );
  await expect(
    new Runtime().launch({
      scratchDirectory: root,
      workspace: root,
      stateDirectory: join(root, "probe-state"),
      policy: { grantsState: true, configuration: "policy" },
    }),
  ).rejects.toThrow("inspection failed");
});
