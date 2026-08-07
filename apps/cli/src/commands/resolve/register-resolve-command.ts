import type { Command as CommanderCommand } from "commander";

import { runCommand } from "../../command.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { resolveCommand } from "./resolve-command.js";

interface ResolveOptions {
  readonly fuzzy: boolean;
  readonly regex: boolean;
  readonly json: boolean;
}

export function registerResolveCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  program
    .command("resolve <query>")
    .description("Find matching symbols and files for a name")
    .option("--fuzzy", "match by fuzzy subsequence instead of exact name", false)
    .option("--regex", "match by JavaScript regex instead of exact name", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (query: string, options: ResolveOptions) => {
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(resolveCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: { query, fuzzy: options.fuzzy, regex: options.regex },
      });
    });
}
