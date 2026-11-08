import type { Command as CommanderCommand } from "commander";
import { resolve } from "node:path";
import { createWorkspace, UserFacingError } from "@symnav/core";
import type { DaemonStatusReport } from "@symnav/daemon";
import { DaemonLifecycleRenderer } from "@symnav/renderer";
import { CommandErrorLine } from "../../output/command-error-line.js";
import { OPERATION_FAILURE_EXIT_CODE, OperationFailure } from "../../output/operation-failure.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";

interface DaemonStartOptions {
  readonly json: boolean;
}

type DaemonOutputOptions = DaemonStartOptions;

class DaemonWorkspaceDirectory {
  static resolve(program: CommanderCommand, context: ProgramContext): string {
    return resolve(context.cwd, program.opts<{ cwd?: string }>().cwd ?? context.cwd);
  }
}

export function registerDaemonCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void {
  const daemon = program.command("daemon").description("Manage the workspace daemon");
  daemon
    .command("start")
    .description("Start and warm the workspace daemon")
    .option("--json", "emit JSON instead of text", false)
    .action(async (options: DaemonStartOptions) => {
      await DaemonStartAction.run(program, context, dependencies, options);
    });
  daemon
    .command("status")
    .description("List running workspace daemons")
    .option("--json", "emit JSON instead of text", false)
    .action(async (options: DaemonOutputOptions) => {
      await DaemonStatusAction.run(context, dependencies, options);
    });
  daemon
    .command("stop")
    .description("Stop the workspace daemon")
    .option("--json", "emit JSON instead of text", false)
    .action(async (options: DaemonOutputOptions) => {
      await DaemonStopAction.run(program, context, dependencies, options);
    });
}

class DaemonStartAction {
  static async run(
    program: CommanderCommand,
    context: ProgramContext,
    dependencies: ProgramDependencies,
    options: DaemonStartOptions,
  ): Promise<void> {
    if (!dependencies.daemonEnabled) {
      context.stderr.write(CommandErrorLine.render("daemon disabled by SYMNAV_DAEMON=0"));
      context.exit(1);
    }
    const cwd = DaemonWorkspaceDirectory.resolve(program, context);
    try {
      const workspace = await createWorkspace({ startDir: cwd, fs: dependencies.fs });
      const result = await dependencies.daemonClient.control({
        action: "start",
        ...(dependencies.stateWriteFailed === undefined
          ? {}
          : { stateWriteFailed: dependencies.stateWriteFailed }),
        workspaceRoot: workspace.root,
      });
      context.stdout.write(
        options.json
          ? DaemonLifecycleRenderer.renderStartJson(result)
          : DaemonLifecycleRenderer.renderStartText(result),
      );
    } catch (error) {
      if (error instanceof UserFacingError) {
        context.stderr.write(error.render());
        context.exit(1);
      }
      context.stderr.write(OperationFailure.render("start daemon", error));
      context.exit(OPERATION_FAILURE_EXIT_CODE);
    }
  }
}

class DaemonStatusAction {
  static async run(
    context: ProgramContext,
    dependencies: ProgramDependencies,
    options: DaemonOutputOptions,
  ): Promise<void> {
    let report: DaemonStatusReport;
    try {
      report = await dependencies.daemonClient.control({
        action: "status",
        ...(dependencies.stateWriteFailed === undefined
          ? {}
          : { stateWriteFailed: dependencies.stateWriteFailed }),
      });
    } catch (error) {
      context.stderr.write(OperationFailure.render("read daemon status", error));
      context.exit(OPERATION_FAILURE_EXIT_CODE);
    }
    context.stdout.write(
      options.json
        ? DaemonLifecycleRenderer.renderStatusJson(report)
        : DaemonLifecycleRenderer.renderStatusText(report),
    );
  }
}

class DaemonStopAction {
  static async run(
    program: CommanderCommand,
    context: ProgramContext,
    dependencies: ProgramDependencies,
    options: DaemonOutputOptions,
  ): Promise<void> {
    const cwd = DaemonWorkspaceDirectory.resolve(program, context);
    try {
      const workspace = await createWorkspace({ startDir: cwd, fs: dependencies.fs });
      const result = await dependencies.daemonClient.control({
        action: "stop",
        ...(dependencies.stateWriteFailed === undefined
          ? {}
          : { stateWriteFailed: dependencies.stateWriteFailed }),
        workspaceRoot: workspace.root,
      });
      context.stdout.write(
        options.json
          ? DaemonLifecycleRenderer.renderStopJson(result)
          : DaemonLifecycleRenderer.renderStopText(result),
      );
    } catch (error) {
      if (error instanceof UserFacingError) {
        context.stderr.write(error.render());
        context.exit(1);
      }
      context.stderr.write(OperationFailure.render("stop daemon", error));
      context.exit(OPERATION_FAILURE_EXIT_CODE);
    }
  }
}
