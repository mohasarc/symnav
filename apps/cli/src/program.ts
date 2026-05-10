import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { ProgramContext } from "./program-context.js";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

function resolveContext(overrides?: Partial<ProgramContext>): ProgramContext {
  return {
    stdout: overrides?.stdout ?? process.stdout,
    stderr: overrides?.stderr ?? process.stderr,
    cwd: overrides?.cwd ?? process.cwd(),
    exit: overrides?.exit ?? ((code: number) => process.exit(code)),
  };
}

export function buildProgram(overrides?: Partial<ProgramContext>): Command {
  const context = resolveContext(overrides);
  const program = new Command();
  program
    .name("symnav")
    .version(readPackageVersion(), "-v, --version")
    .configureOutput({
      writeOut: (s) => {
        context.stdout.write(s);
      },
      writeErr: (s) => {
        context.stderr.write(s);
      },
    })
    .exitOverride((err) => {
      context.exit(err.exitCode);
    })
    .action(() => {
      program.outputHelp({ error: true });
      context.exit(1);
    });
  return program;
}
