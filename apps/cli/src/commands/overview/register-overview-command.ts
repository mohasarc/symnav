import type { Command as CommanderCommand } from "commander";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { runCommand } from "../../command.js";
import { overviewCommand } from "./overview-command.js";

export function registerOverviewCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("overview <file>")
    .description("Print a one-screen overview of a file's symbols")
    .option("--json", "emit JSON instead of text", false)
    .action(async (file: string, options: { json: boolean }) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(overviewCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: { file },
      });
    });
}
