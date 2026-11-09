import type { Command as CommanderCommand } from "commander";

import { runCommand } from "../../command.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { defCommand } from "./def-command.js";

interface DefOptions {
  readonly line?: string;
  readonly regex: boolean;
  readonly source: boolean;
  readonly json: boolean;
}

export function registerDefCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("def <target>")
    .description("Show where a symbol is defined")
    .option("--line <n>", "narrow target matches to declarations containing this line")
    .option("--regex", "match full canonical symbol ids by JavaScript regex", false)
    .option("--source", "print each definition's source with line numbers", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (target: string, options: DefOptions) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(defCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: {
          target,
          line: options.line,
          regex: options.regex,
          source: options.source,
        },
      });
    });
}
