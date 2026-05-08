import { resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import { BackendError, BackendRouter, NotInWorkspaceError, runOverview } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { ResolvedProgramContext } from "../program.js";
import { formatUserError } from "../error-output.js";

interface OverviewOptions {
  json?: boolean;
}

export function registerOverviewCommand(program: Command, context: ResolvedProgramContext): void {
  program
    .command("overview")
    .description("Show the symbol structure of a file")
    .argument("<file>", "file to inspect")
    .option("--json", "emit a structured JSON variant of the IR")
    .action(async (file: string, options: OverviewOptions) => {
      const cwdOption = (program.opts() as { cwd?: string }).cwd;
      const cwd = cwdOption ? pathResolve(context.cwd, cwdOption) : context.cwd;

      let result;
      try {
        const workspace = await context.createWorkspace(cwd);
        const router = new BackendRouter(context.buildBackends(workspace));
        result = await runOverview({
          workspace,
          router,
          cwd,
          inputPath: file,
        });
      } catch (err) {
        const formatted = formatUserError(err);
        if (formatted !== null) {
          context.stderr.write(`${formatted}\n`);
          context.exit(1);
          return;
        }
        if (err instanceof BackendError || err instanceof NotInWorkspaceError) {
          context.stderr.write(`${err.message}\n`);
          context.exit(1);
          return;
        }
        context.stderr.write(
          `Internal error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        context.exit(2);
        return;
      }
      const output = options.json ? renderOverviewJson(result) : renderOverviewText(result);
      context.stdout.write(output);
    });
}
