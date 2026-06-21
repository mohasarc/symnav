import type { Command as CommanderCommand } from "commander";
import { aggregate, NodeUsageLogReader, resolveStateDir, usageLogPath } from "@symnav/telemetry";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { renderStatsJson, renderStatsText } from "./render-stats.js";

interface StatsOptions {
  readonly json: boolean;
}

export function registerStatsCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  void dependencies;

  program
    .command("stats", { hidden: true })
    .option("--json", "emit JSON instead of text", false)
    .action((options: StatsOptions) => {
      const stateDir = resolveStateDir(process.env);
      const events = new NodeUsageLogReader().read(usageLogPath(stateDir));
      const summary = aggregate(events);
      context.stdout.write(options.json ? renderStatsJson(summary) : renderStatsText(summary));
    });
}
