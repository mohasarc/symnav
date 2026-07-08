import type { Command as CommanderCommand } from "commander";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { runCommand } from "../../command.js";
import { overviewCommand } from "./overview-command.js";

interface OverviewOptions {
  readonly depth?: string;
  readonly at?: string;
  readonly line?: string;
  readonly json: boolean;
}

export function registerOverviewCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("overview <file>")
    .description("Print a one-screen overview of a file's symbols")
    .option("--depth <n>", "number of child tree levels to render")
    .option("--at <text>", "expand the overview node whose header contains text")
    .option("--line <n>", "narrow overview target candidates to a source line")
    .option("--json", "emit JSON instead of text", false)
    .action(async (file: string, options: OverviewOptions) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(overviewCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: {
          file,
          depth: options.depth,
          at: options.at,
          line: options.line,
        },
      });
    });
}
