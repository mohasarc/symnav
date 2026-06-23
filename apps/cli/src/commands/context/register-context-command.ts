import type { Command as CommanderCommand } from "commander";

import { runCommand } from "../../command.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { contextCommand } from "./context-command.js";

export function registerContextCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("context <symbol-id>")
    .description("Show a symbol's definition, callers, callees, references, and recent history")
    .option("--json", "emit JSON instead of text", false)
    .action(async (symbolId: string, options: { json: boolean }) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(contextCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: { symbolId },
      });
    });
}
