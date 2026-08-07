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
    .command("def <target>")
    .description("Show where a symbol is defined")
    .option("--line <n>", "narrow target matches to declarations containing this line")
    .option("--json", "emit JSON instead of text", false)
    .action(async (target: string, options: { line?: string; json: boolean }) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(defCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: {
          target,
          line: options.line,
        },
      });
    });
}
