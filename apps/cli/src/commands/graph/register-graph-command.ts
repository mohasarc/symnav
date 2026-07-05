import type { Command as CommanderCommand } from "commander";

import { runCommand } from "../../command.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { graphCommand } from "./graph-command.js";

interface GraphOptions {
  readonly incoming: boolean;
  readonly outgoing: boolean;
  readonly depth?: string;
  readonly page?: string;
  readonly pageSize?: string;
  readonly all: boolean;
  readonly json: boolean;
}

export function registerGraphCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("graph <symbol-id>")
    .description("Show call paths around a symbol")
    .option("--incoming", "show caller paths only", false)
    .option("--outgoing", "show callee paths only", false)
    .option("--depth <n>", "maximum call depth")
    .option("--page <n>", "page of graph paths to show")
    .option("--page-size <n>", "graph paths per page")
    .option("--all", "show every graph path on one page", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (symbolId: string, options: GraphOptions) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(graphCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: {
          symbolId,
          incoming: options.incoming,
          outgoing: options.outgoing,
          depth: options.depth,
          page: options.page === undefined ? undefined : Number(options.page),
          pageSize: options.pageSize === undefined ? undefined : Number(options.pageSize),
          all: options.all,
        },
      });
    });
}
