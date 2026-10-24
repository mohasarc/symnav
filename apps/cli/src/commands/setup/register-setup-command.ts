import { Argument, type Command } from "commander";
import { homedir } from "node:os";
import type {
  AgentConfigurationLocations,
  SupportedAgent,
} from "../../agent-sandbox/agent-configuration.js";
import { ClaudeCodeSandboxConfiguration } from "../../agent-sandbox/claude-code-configuration.js";
import { CodexSandboxConfiguration } from "../../agent-sandbox/codex-configuration.js";
import { StateDirectoryResolver } from "../../state-directory-resolver.js";
import type { ProgramContext } from "../../program-context.js";

export function registerSetupCommand(program: Command, context: ProgramContext): void {
  program
    .command("setup")
    .description("grant Codex or Claude Code write access to the state directory")
    .addArgument(new Argument("<agent>", "agent to configure").choices(["codex", "claude-code"]))
    .allowExcessArguments(false)
    .action(async (agent: SupportedAgent) => {
      const locations: AgentConfigurationLocations = {
        homeDirectory: homedir(),
        ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME }),
        ...(process.env.CLAUDE_CONFIG_DIR === undefined
          ? {}
          : { claudeConfigurationDirectory: process.env.CLAUDE_CONFIG_DIR }),
      };
      const configuration =
        agent === "codex"
          ? new CodexSandboxConfiguration(locations)
          : new ClaudeCodeSandboxConfiguration(locations);
      try {
        const result = await configuration.grant(new StateDirectoryResolver().resolve());
        const agentName = result.agent === "codex" ? "Codex" : "Claude Code";
        if (result.changed) {
          context.stdout.write(
            `Granted write access to ${result.stateDirectory} in ${result.configurationPath}\nRestart ${agentName} sessions to apply.\n`,
          );
        } else {
          context.stdout.write(
            `${agentName} already grants write access to ${result.stateDirectory} (${result.configurationPath})\n`,
          );
        }
        if (!result.installed)
          context.stdout.write(
            `${agentName} was not found on PATH; the grant applies when installed.\n`,
          );
      } catch (error) {
        context.stderr.write(
          `symnav: error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        context.exit(1);
      }
    });
}
