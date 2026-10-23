import type { AgentProbePolicy } from "./agent-probe-policy.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeCodeSandboxRuntime } from "./claude-code-runtime.js";
import { AgentExecutable } from "./agent-executable.js";
import type { SandboxProbeRequest } from "./agent-sandbox-runtime.js";
class Runtime extends ClaudeCodeSandboxRuntime {
  public launch(request: SandboxProbeRequest) {
    return this.command(request);
  }
}
class RuntimeScratch {
  public static readonly roots: string[] = [];
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    RuntimeScratch.roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("launches standalone SRT with translated policy and no tested-state grant injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-launch-"));
  RuntimeScratch.roots.push(root);
  vi.spyOn(AgentExecutable, "find").mockResolvedValue("/runtime/srt");
  const policy: AgentProbePolicy = {
    grantsState: true,
    configuration: JSON.stringify({
      network: { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: { allowWrite: ["/state"], denyWrite: ["/state/denied"], denyRead: ["/secret"] },
    }),
  };
  const command = await new Runtime().launch({
    scratchDirectory: root,
    workspace: join(root, "workspace"),
    stateDirectory: join(root, "probe-state"),
    policy,
  });
  expect(command.argv).toEqual([
    "--settings",
    join(root, "srt-settings.json"),
    "--",
    process.execPath,
    expect.stringContaining("sandbox-probe-entry.js"),
  ]);
  expect(await readFile(join(root, "srt-settings.json"), "utf8")).toBe(policy.configuration);
  expect(command.environment.SYMNAV_STATE_DIR).toBe(join(root, "probe-state"));
  expect(command.environment.CLAUDE_CODE_TMPDIR).toBe(command.cwd);
});
it("reports genuine missing SRT availability", async () => {
  vi.spyOn(AgentExecutable, "find").mockResolvedValue(undefined);
  expect(await new Runtime().availability()).toBe(
    process.platform === "win32" ? "not-exposable" : "not-found",
  );
});
