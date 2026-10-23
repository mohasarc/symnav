import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProbeRequest } from "./agent-sandbox-runtime.js";
import { AgentExecutable } from "./agent-executable.js";
import { CommandAgentSandboxRuntime } from "./command-agent-sandbox-runtime.js";
import type { SandboxLaunchCommand } from "./sandbox-launch-command.js";

export class ClaudeCodeSandboxRuntime extends CommandAgentSandboxRuntime {
  public readonly agent = "claude-code";
  public async availability(): Promise<"available" | "not-found" | "not-exposable"> {
    if (process.platform !== "darwin" && process.platform !== "linux") return "not-exposable";
    return (await AgentExecutable.find("srt")) === undefined ? "not-found" : "available";
  }
  protected async command(request: SandboxProbeRequest): Promise<SandboxLaunchCommand> {
    const executable = await AgentExecutable.find("srt");
    if (executable === undefined) throw new Error("sandbox runtime disappeared from PATH");
    const settings = join(request.scratchDirectory, "srt-settings.json");
    await writeFile(settings, request.policy.configuration, { mode: 0o600, flag: "wx" });
    return {
      executable,
      argv: ["--settings", settings, "--", process.execPath, this.entry()],
      cwd: request.workspace,
      environment: { ...this.environment(request), CLAUDE_CODE_TMPDIR: request.workspace },
    };
  }
}
