import type { Command as CommanderCommand } from "commander";

import { runCommand } from "../../command.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { refsCommand } from "./refs-command.js";

interface RefsOptions {
  readonly page?: string;
  readonly pageSize?: string;
  readonly all: boolean;
  readonly fullLines: boolean;
  readonly json: boolean;
}

export function registerRefsCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("refs <symbol-id>")
    .description("List references to a symbol across the workspace")
    .option("--page <n>", "page of references to show")
    .option("--page-size <n>", "references per page")
    .option("--all", "show every reference on one page", false)
    .option("--full-lines", "emit source lines verbatim, untrimmed", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (symbolId: string, options: RefsOptions) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(refsCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: {
          symbolId,
          page: options.page === undefined ? undefined : Number(options.page),
          pageSize: options.pageSize === undefined ? undefined : Number(options.pageSize),
          all: options.all,
          fullLines: options.fullLines,
        },
      });
    });
}
