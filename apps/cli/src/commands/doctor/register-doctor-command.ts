import { Argument, type Command } from "commander";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AgentConfigurationLocations,
  SupportedAgent,
} from "../../agent-sandbox/agent-configuration.js";
import type { AgentDoctorResult } from "../../agent-sandbox/agent-doctor-result.js";
import { AgentSandboxDoctor } from "../../agent-sandbox/agent-sandbox-doctor.js";
import { ClaudeCodeSandboxConfiguration } from "../../agent-sandbox/claude-code-configuration.js";
import { ClaudeCodeSandboxRuntime } from "../../agent-sandbox/claude-code-runtime.js";
import { CodexSandboxConfiguration } from "../../agent-sandbox/codex-configuration.js";
import { CodexSandboxRuntime } from "../../agent-sandbox/codex-runtime.js";
import type { ProgramContext } from "../../program-context.js";
import { StateDirectoryResolver } from "../../state-directory-resolver.js";

export function registerDoctorCommand(program: Command, context: ProgramContext): void {
  program
    .command("doctor")
    .description("check sandboxed daemon execution and telemetry")
    .addArgument(new Argument("[agent]", "agent to check").choices(["codex", "claude-code"]))
    .allowExcessArguments(false)
    .action(async (agent?: SupportedAgent) => DoctorCommandAction.run(program, context, agent));
}

class DoctorCommandAction {
  public static async run(
    program: Command,
    context: ProgramContext,
    agent?: SupportedAgent,
  ): Promise<void> {
    const stateDirectory = new StateDirectoryResolver().resolve();
    const locations: AgentConfigurationLocations = {
      homeDirectory: homedir(),
      workspaceDirectory: resolve(context.cwd, program.opts<{ cwd?: string }>().cwd ?? context.cwd),
      ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME }),
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { claudeConfigurationDirectory: process.env.CLAUDE_CONFIG_DIR }),
    };
    const doctor = new AgentSandboxDoctor({
      stateDirectory,
      configurations: [
        new CodexSandboxConfiguration(locations),
        new ClaudeCodeSandboxConfiguration(locations),
      ],
      runtimes: [new CodexSandboxRuntime(), new ClaudeCodeSandboxRuntime()],
    });
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("sandbox probe cancelled"));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    let results: readonly AgentDoctorResult[];
    try {
      results = await doctor.check(agent, controller.signal);
    } catch (error) {
      context.stderr.write(
        `symnav: error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      context.exit(1);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    for (const result of results)
      context.stdout.write(
        `${result.agent.padEnd(13)}${result.status.padEnd(6)}${this.message(result, stateDirectory)}\n`,
      );
    if (results.some((result) => result.status === "fail")) context.exit(1);
  }
  private static message(result: AgentDoctorResult, stateDirectory: string): string {
    if (result.status !== "ok") return result.reason;
    return result.check === "live"
      ? "daemon warm inside sandbox, telemetry recorded"
      : `configuration grants ${stateDirectory}; live sandbox check skipped: ${result.skippedReason}`;
  }
}
