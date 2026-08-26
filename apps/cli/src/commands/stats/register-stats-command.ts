import type { Command as CommanderCommand } from "commander";
import { NodeUsageLogReader, UsageAggregator, usageLogPath } from "@symnav/telemetry";
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
  program
    .command("stats", { hidden: true })
    .option("--json", "emit JSON instead of text", false)
    .action((options: StatsOptions) => {
      const telemetryStartedAt = dependencies.clock.now();
      const events = new NodeUsageLogReader()
        .read(usageLogPath(dependencies.stateDirectory))
        .filter((event) => event.command !== "stats");
      const summary = new UsageAggregator(events).aggregate();
      context.stdout.write(options.json ? renderStatsJson(summary) : renderStatsText(summary));
      if (!dependencies.telemetryEnabled) return;
      try {
        const identity = dependencies.identity.resolve({
          cwd: context.cwd,
          workspaceRoot: undefined,
        });
        dependencies.recorder.record({
          symnavVersion: dependencies.symnavVersion,
          command: "stats",
          timestamp: telemetryStartedAt,
          durationMs: dependencies.clock.now() - telemetryStartedAt,
          executionMode: dependencies.executionMode ?? "cold",
          outcome: "success",
          argShape: {
            kind: "empty",
            lengthBucket: "empty",
            flags: options.json ? ["json"] : [],
          },
          workspaceId: identity.workspaceId,
          machineId: identity.machineId,
        });
      } catch {
        return;
      }
    });
}
