import { Argument, type Command } from "commander";
import { homedir } from "node:os";
import { CodexSandboxConfiguration } from "../../agent-sandbox/codex-configuration.js";
import { StateDirectoryResolver } from "../../state-directory-resolver.js";
import type { ProgramContext } from "../../program-context.js";

export function registerSetupCommand(program: Command, context: ProgramContext): void {
  program
    .command("setup")
    .description("grant an agent sandbox write access to the symnav state directory")
    .addArgument(new Argument("<agent>", "agent to configure").choices(["codex"]))
    .allowExcessArguments(false)
    .action(async () => {
      const configuration = new CodexSandboxConfiguration({
        homeDirectory: homedir(),
        ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME }),
      });
      try {
        const result = await configuration.grant(new StateDirectoryResolver().resolve());
        if (result.changed) {
          context.stdout.write(
            `Granted write access to ${result.stateDirectory} in ${result.configurationPath}\nRestart Codex sessions to apply.\n`,
          );
        } else {
          context.stdout.write(
            `Codex already grants write access to ${result.stateDirectory} (${result.configurationPath})\n`,
          );
        }
        if (!result.installed)
          context.stdout.write("Codex was not found on PATH; the grant applies when installed.\n");
      } catch (error) {
        context.stderr.write(
          `symnav: error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        context.exit(1);
      }
    });
}
