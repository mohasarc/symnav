import type { Command } from "commander";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { runOverviewAction } from "./run-overview-action.js";

export function registerOverviewCommand(
  program: Command,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("overview <file>")
    .description("Print a one-screen overview of a file's symbols")
    .option("--json", "emit JSON instead of text", false)
    .action(async (file: string, options: { json: boolean }) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runOverviewAction({
        context,
        dependencies,
        file,
        json: options.json,
        cwdOverride,
      });
    });
}
