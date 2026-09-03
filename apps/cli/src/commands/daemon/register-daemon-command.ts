import type { Command as CommanderCommand } from "commander";
import { createWorkspace, UserFacingError } from "@symnav/core";
import { DaemonController } from "../../daemon/daemon-controller.js";
import { DaemonLifecycleRenderer } from "../../daemon/daemon-lifecycle-renderer.js";
import { DaemonRegistry } from "../../daemon/daemon-registry.js";
import { NodeDaemonProcessLauncher } from "../../daemon/daemon-process-launcher.js";
import { DaemonWorkspaceIdentity } from "../../daemon/daemon-workspace-identity.js";
import { LocalDaemonTransport } from "../../daemon/local-daemon-transport.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";

interface DaemonStartOptions {
  readonly json: boolean;
}

type DaemonOutputOptions = DaemonStartOptions;

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
    if (process.env.SYMNAV_DAEMON === "0") {
      context.stderr.write("Daemon disabled by SYMNAV_DAEMON=0\n");
      context.exit(1);
    }
    const cwd = program.opts<{ cwd?: string }>().cwd ?? context.cwd;
    try {
      const workspace = await createWorkspace({ startDir: cwd, fs: dependencies.fs });
      const stateDirectory = dependencies.stateDirectory;
      const identity = DaemonWorkspaceIdentity.from(workspace.root, stateDirectory);
      const registry = new DaemonRegistry(
        identity.registryDirectory,
        dependencies.daemonPolicy.values.startup,
      );
      const controller = new DaemonController(
        registry,
        new LocalDaemonTransport(dependencies.daemonPolicy.values),
        stateDirectory,
        {
          policy: dependencies.daemonPolicy.values,
          launcher: new NodeDaemonProcessLauncher(
            dependencies.symnavVersion,
            dependencies.daemonPolicy,
          ),
        },
      );
      const result = await controller.start(workspace.root);
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
      const message = error instanceof Error ? error.message : String(error);
      context.stderr.write(`Cannot start daemon: ${message}\n`);
      context.exit(2);
    }
  }
}

class DaemonStatusAction {
  static async run(
    context: ProgramContext,
    dependencies: ProgramDependencies,
    options: DaemonOutputOptions,
  ): Promise<void> {
    const stateDirectory = dependencies.stateDirectory;
    const registry = new DaemonRegistry(
      DaemonWorkspaceIdentity.registryDirectory(stateDirectory),
      dependencies.daemonPolicy.values.startup,
    );
    const controller = new DaemonController(
      registry,
      new LocalDaemonTransport(dependencies.daemonPolicy.values),
      stateDirectory,
      { policy: dependencies.daemonPolicy.values },
    );
    const results = await controller.status();
    context.stdout.write(
      options.json
        ? DaemonLifecycleRenderer.renderStatusJson(results)
        : DaemonLifecycleRenderer.renderStatusText(results),
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
    const cwd = program.opts<{ cwd?: string }>().cwd ?? context.cwd;
    try {
      const workspace = await createWorkspace({ startDir: cwd, fs: dependencies.fs });
      const stateDirectory = dependencies.stateDirectory;
      const registry = new DaemonRegistry(
        DaemonWorkspaceIdentity.registryDirectory(stateDirectory),
        dependencies.daemonPolicy.values.startup,
      );
      const controller = new DaemonController(
        registry,
        new LocalDaemonTransport(dependencies.daemonPolicy.values),
        stateDirectory,
        { policy: dependencies.daemonPolicy.values },
      );
      const result = await controller.stop(workspace.root);
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
      const message = error instanceof Error ? error.message : String(error);
      context.stderr.write(`Cannot stop daemon: ${message}\n`);
      context.exit(2);
    }
  }
}
