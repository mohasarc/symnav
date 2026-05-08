import { resolve } from "node:path";
import type { Command } from "commander";
import {
  BackendRouter,
  createWorkspace,
  nodeFileSystem,
  runOverview,
} from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { ProgramContext } from "../program.js";
import { formatUserError } from "../error-output.js";

interface OverviewOptions {
  json?: boolean;
}

interface GlobalOptions {
  cwd?: string;
}

/**
 * Wire the `overview <file>` subcommand onto the given Commander program.
 *
 * The action resolves the effective working directory (global `--cwd` wins
 * over the program context's default), constructs a `Workspace` and a
 * `TypeScriptBackend`-only router, and dispatches to `runOverview`. Output
 * goes to `context.stdout` via the appropriate renderer; user-facing errors
 * (`BackendError`, `NotInWorkspaceError`) are formatted to `context.stderr`
 * with exit 1; any other error exits 2.
 */
export function registerOverviewCommand(
  program: Command,
  context: ProgramContext,
): void {
  program
    .command("overview")
    .description("Print the symbol structure of a TypeScript file")
    .argument("<file>", "path to the TypeScript file to summarize")
    .option("--json", "emit machine-readable JSON instead of text", false)
    .action(async (file: string, options: OverviewOptions) => {
      const globals = program.opts<GlobalOptions>();
      const effectiveCwd = resolve(globals.cwd ?? context.cwd);
      try {
        const workspace = await createWorkspace({
          startDir: effectiveCwd,
          fs: nodeFileSystem(),
        });
        const backend = new TypeScriptBackend(workspace);
        const router = new BackendRouter([backend]);
        const ir = await runOverview({
          workspace,
          router,
          cwd: effectiveCwd,
          inputPath: file,
        });
        const output = options.json
          ? renderOverviewJson(ir)
          : renderOverviewText(ir);
        context.stdout.write(output);
      } catch (err) {
        const formatted = formatUserError(err);
        if (formatted !== null) {
          context.stderr.write(`${formatted}\n`);
          context.exit(1);
        }
        context.stderr.write(
          `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
        context.exit(2);
      }
    });
}
