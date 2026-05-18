import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command as CommanderCommand } from "commander";
import { NodeFileSystem } from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { registerOverviewCommand } from "./commands/overview/register-overview-command.js";
import { registerResolveCommand } from "./commands/resolve/register-resolve-command.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

function defaultContext(): ProgramContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    exit: (code: number) => process.exit(code),
  };
}

function defaultDependencies(): ProgramDependencies {
  const fs = new NodeFileSystem();
  return {
    fs,
    backends: () => [new TypeScriptBackend(fs)],
  };
}

export function buildProgram(
  context?: ProgramContext,
  dependencies?: ProgramDependencies,
): CommanderCommand {
  const ctx = context ?? defaultContext();
  const deps = dependencies ?? defaultDependencies();
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
  return program;
}
