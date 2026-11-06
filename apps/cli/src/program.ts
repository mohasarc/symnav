import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InvocationProgram } from "./invocation-program.js";
import { NodeFileSystem } from "@symnav/core";
import { DaemonClient, DaemonPolicy, type DaemonExecutorFactory } from "@symnav/daemon";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { NodeTelemetryWritePort, NodeUsageRecorder, usageLogPath } from "@symnav/telemetry";
import type { Clock, TelemetryFailureObserver } from "@symnav/telemetry";
import { registerContextCommand } from "./commands/context/register-context-command.js";
import { registerDoctorCommand } from "./commands/doctor/register-doctor-command.js";
import { registerDaemonCommand } from "./commands/daemon/register-daemon-command.js";
import { registerDefCommand } from "./commands/def/register-def-command.js";
import { registerGraphCommand } from "./commands/graph/register-graph-command.js";
import { NodeGitHistory } from "./git/node-git-history.js";
import { registerOverviewCommand } from "./commands/overview/register-overview-command.js";
import { registerRefsCommand } from "./commands/refs/register-refs-command.js";
import { registerResolveCommand } from "./commands/resolve/register-resolve-command.js";
import { registerSetupCommand } from "./commands/setup/register-setup-command.js";
import { registerStatsCommand } from "./commands/stats/register-stats-command.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { isTelemetryEnabled } from "./telemetry/is-telemetry-enabled.js";
import {
  NodeGitRemoteReader,
  NodeTelemetryIdentityProvider,
} from "./telemetry/node-telemetry-identity-provider.js";
import { StateDirectoryResolver } from "./state-directory-resolver.js";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

export function createDefaultProgramContext(): ProgramContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    exit: (code: number) => process.exit(code),
  };
}

export function createDefaultDependencies(
  canonicalStateDirectory: string,
  daemonPolicy: DaemonPolicy,
  daemonEnabled = true,
): ProgramDependencies {
  const fs = new NodeFileSystem();
  const clock: Clock = { now: () => Date.now() };
  const symnavVersion = readPackageVersion();
  const sessionId = randomUUID();
  const invocationTelemetry = (observer?: TelemetryFailureObserver) => ({
    recorder: new NodeUsageRecorder(
      new NodeTelemetryWritePort(usageLogPath(canonicalStateDirectory), observer),
      { next: () => sessionId },
    ),
    identity: new NodeTelemetryIdentityProvider(
      canonicalStateDirectory,
      new NodeGitRemoteReader(),
      undefined,
      observer,
    ),
  });
  let dependencies: ProgramDependencies;
  const executorFactory: DaemonExecutorFactory = async (options) => {
    const { createDaemonExecutorFromDependencies } = await import("./daemon-executor.js");
    return createDaemonExecutorFromDependencies(options, dependencies);
  };
  const daemonClient = new DaemonClient({
    stateDirectory: canonicalStateDirectory,
    productVersion: symnavVersion,
    daemonEnabled,
    executorFactory,
    executorModuleUrl: new URL("./daemon-executor.js", import.meta.url).href,
    readinessProbe: { commandName: "version", argv: ["--version"] },
    policy: daemonPolicy,
  });
  dependencies = {
    stateDirectory: canonicalStateDirectory,
    daemonPolicy,
    daemonClient,
    daemonEnabled,
    fs,
    backends: () => [new TypeScriptBackend(fs)],
    git: new NodeGitHistory(),
    ...invocationTelemetry(),
    invocationTelemetry,
    clock,
    telemetryEnabled: isTelemetryEnabled(process.env),
    symnavVersion,
  };
  return dependencies;
}

export function buildProgram(
  context?: ProgramContext,
  dependencies?: ProgramDependencies,
): InvocationProgram {
  const ctx = context ?? createDefaultProgramContext();
  const deps =
    dependencies ??
    createDefaultDependencies(
      process.env.SYMNAV_DAEMON === "0" && !isTelemetryEnabled(process.env)
        ? ""
        : new StateDirectoryResolver(process.env).resolve(),
      DaemonPolicy.currentSystem(),
      process.env.SYMNAV_DAEMON !== "0",
    );
  const program = new InvocationProgram();
  program
    .name("symnav")
    .version(readPackageVersion(), "-v, --version")
    .option("--cwd <dir>", "run as if symnav was started in <dir>")
    .option("--no-warnings", "suppress warning messages")
    .configureOutput({
      writeOut: (s) => {
        ctx.stdout.write(s);
      },
      writeErr: (s) => {
        ctx.stderr.write(s);
      },
    })
    .exitOverride((err) => {
      ctx.exit(err.exitCode);
    })
    .action(() => {
      program.outputHelp({ error: true });
      ctx.exit(1);
    });
  const commandDependencies: ProgramDependencies = {
    ...deps,
    get warningOptions() {
      return { warnings: program.opts<{ warnings: boolean }>().warnings };
    },
  };
  registerOverviewCommand(program, ctx, commandDependencies);
  registerResolveCommand(program, ctx, commandDependencies);
  registerDefCommand(program, ctx, commandDependencies);
  registerRefsCommand(program, ctx, commandDependencies);
  registerContextCommand(program, ctx, commandDependencies);
  registerGraphCommand(program, ctx, commandDependencies);
  registerDaemonCommand(program, ctx, commandDependencies);
  registerStatsCommand(program, ctx, commandDependencies);
  registerSetupCommand(program, ctx);
  registerDoctorCommand(program, ctx);
  return program;
}
