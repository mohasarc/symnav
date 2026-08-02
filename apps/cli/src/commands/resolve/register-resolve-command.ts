import type { ResolveSymbolsMode } from "@symnav/core";
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
    .option("--regex", "match by JavaScript regex against symbol names", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (query: string, options: ResolveOptions) => {
      if (options.fuzzy && options.regex) {
        context.stderr.write("Cannot answer: --regex cannot be combined with --fuzzy.\n");
        context.exit(1);
        return;
      }
      const cwdOverride = program.opts<{ cwd?: string }>().cwd;
      await runCommand(resolveCommand, {
        context,
        dependencies,
        cwdOverride,
        json: options.json,
        args: { query, mode: ResolveOptionsResolver.resolveMode(options) },
      });
    });
}

class ResolveOptionsResolver {
  static resolveMode(options: ResolveOptions): ResolveSymbolsMode {
    if (options.fuzzy) return "fuzzy";
    if (options.regex) return "regex";
    return "exact";
  }
}
