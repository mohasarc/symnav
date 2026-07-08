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
    .command("context <target>")
    .description("Show a symbol's definition, callers, callees, references, and recent history")
    .option("--line <n>", "narrow target matches to declarations containing this line")
    .option("--json", "emit JSON instead of text", false)
    .action(async (target: string, options: { line?: string; json: boolean }) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(contextCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: {
          target,
          line: options.line === undefined ? undefined : Number(options.line),
        },
      });
    });
}
