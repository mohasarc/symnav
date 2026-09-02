import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command as CommanderCommand } from "commander";
import { NodeFileSystem } from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import {
  NodeTelemetryWritePort,
  NodeUsageRecorder,
  resolveStateDir,
  usageLogPath,
} from "@symnav/telemetry";
import type { Clock } from "@symnav/telemetry";
import { registerContextCommand } from "./commands/context/register-context-command.js";
import { registerDaemonCommand } from "./commands/daemon/register-daemon-command.js";
import { registerDefCommand } from "./commands/def/register-def-command.js";
import { registerGraphCommand } from "./commands/graph/register-graph-command.js";
import { NodeGitHistory } from "./git/node-git-history.js";
import { registerOverviewCommand } from "./commands/overview/register-overview-command.js";
import { registerRefsCommand } from "./commands/refs/register-refs-command.js";
import { registerResolveCommand } from "./commands/resolve/register-resolve-command.js";
import { registerStatsCommand } from "./commands/stats/register-stats-command.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { isTelemetryEnabled } from "./telemetry/is-telemetry-enabled.js";
import {
  NodeGitRemoteReader,
  NodeTelemetryIdentityProvider,
} from "./telemetry/node-telemetry-identity-provider.js";

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

export function createDefaultDependencies(): ProgramDependencies {
  const fs = new NodeFileSystem();
  const clock: Clock = { now: () => Date.now() };
  const stateDir = resolveStateDir(process.env);
  return {
    fs,
    backends: () => [new TypeScriptBackend(fs)],
    git: new NodeGitHistory(),
    recorder: new NodeUsageRecorder(new NodeTelemetryWritePort(usageLogPath(stateDir)), {
      next: () => randomUUID(),
    }),
    clock,
    telemetryEnabled: isTelemetryEnabled(process.env),
    identity: new NodeTelemetryIdentityProvider(stateDir, new NodeGitRemoteReader()),
    symnavVersion: readPackageVersion(),
  };
}

export function buildProgram(
  context?: ProgramContext,
  dependencies?: ProgramDependencies,
): CommanderCommand {
  const ctx = context ?? createDefaultProgramContext();
  const deps = dependencies ?? createDefaultDependencies();
  const program = new CommanderCommand();
  program
    .name("symnav")
    .version(readPackageVersion(), "-v, --version")
    .option("--cwd <dir>", "run as if symnav was started in <dir>")
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
  registerOverviewCommand(program, ctx, deps);
  registerResolveCommand(program, ctx, deps);
  registerDefCommand(program, ctx, deps);
  registerRefsCommand(program, ctx, deps);
  registerContextCommand(program, ctx, deps);
  registerGraphCommand(program, ctx, deps);
  registerDaemonCommand(program, ctx, deps);
  registerStatsCommand(program, ctx, deps);
  return program;
}
