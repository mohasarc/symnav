import type { Command as CommanderCommand } from "commander";

import { runCommand } from "../../command.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { defCommand } from "./def-command.js";

export function registerDefCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("def <symbol-id>")
    .description("Show where a symbol is defined")
    .option("--json", "emit JSON instead of text", false)
    .action(async (symbolId: string, options: { json: boolean }) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(defCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: { symbolId },
      });
    });
}
