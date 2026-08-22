import type { Command as CommanderCommand } from "commander";
import { createWorkspace, UserFacingError } from "@symnav/core";
import { resolveStateDir } from "@symnav/telemetry";
import type { DaemonStartResult } from "../../daemon/daemon-protocol.js";
import { DaemonRegistry } from "../../daemon/daemon-registry.js";
import { NodeDaemonProcessLauncher } from "../../daemon/daemon-process-launcher.js";
import { DaemonStartupCoordinator } from "../../daemon/daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "../../daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../daemon/local-daemon-transport.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";

interface DaemonStartOptions {
  readonly json: boolean;
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
}

class DaemonStartAction {
  static async run(
    program: CommanderCommand,
    context: ProgramContext,
    dependencies: ProgramDependencies,
    options: DaemonStartOptions,
  ): Promise<void> {
    const cwd = program.opts<{ cwd?: string }>().cwd ?? context.cwd;
    try {
      const workspace = await createWorkspace({ startDir: cwd, fs: dependencies.fs });
      const identity = DaemonWorkspaceIdentity.from(workspace.root, resolveStateDir(process.env));
      const registry = new DaemonRegistry(identity.registryDirectory);
      const coordinator = new DaemonStartupCoordinator(
        registry,
        new NodeDaemonProcessLauncher(dependencies.symnavVersion),
        new LocalDaemonTransport(),
      );
      const result = await coordinator.ensureRunning(identity);
      context.stdout.write(
        options.json ? DaemonStartAction.renderJson(result) : DaemonStartAction.renderText(result),
      );
    } catch (error) {
      if (error instanceof UserFacingError) {
        context.stderr.write(error.render());
        context.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      context.stderr.write(`Cannot start daemon: ${message}\n`);
      context.exit(2);
    }
  }

  private static renderText(result: DaemonStartResult): string {
    if (result.status === "ready") {
      return `Daemon ready for ${result.workspaceRoot}\n${result.fileCount} files loaded in ${DaemonStartAction.duration(result.loadDurationMs)}\n`;
    }
    if (result.status === "already-running") {
      return `Daemon already running for ${result.workspaceRoot} (pid ${result.pid}, up ${DaemonStartAction.uptime(result.uptimeMs)})\n`;
    }
    return "Daemon disabled by SYMNAV_DAEMON=0\n";
  }

  private static renderJson(result: DaemonStartResult): string {
    return `${JSON.stringify(result)}\n`;
  }

  private static duration(durationMs: number): string {
    if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  private static uptime(uptimeMs: number): string {
    const seconds = Math.max(0, Math.floor(uptimeMs / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }
}
