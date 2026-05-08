import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { LanguageBackend, Workspace } from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { registerOverviewCommand } from "./commands/overview.js";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

/**
 * Optional dependencies the CLI takes from its environment. All fields default
 * to the corresponding `process.*` value; tests inject in-memory streams, a
 * fixed cwd, and a non-throwing `exit` to capture program behavior in-process.
 */
export interface BuildProgramOptions {
  /** Stream the program writes successful command output to. Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Stream the program writes errors and usage to. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /** Working directory for relative-path resolution and root detection. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Process-exit hook. Defaults to `process.exit`. Tests pass a function that throws so flow halts predictably. */
  exit?: (code: number) => never;
  /**
   * Backend factory; given the constructed `Workspace`, returns the ordered
   * list of `LanguageBackend`s to register with the router. Defaults to a
   * single `TypeScriptBackend(workspace)`. Tests inject a fake to exercise
   * router/error-handling code paths without standing up ts-morph.
   */
  backendsFor?: (workspace: Workspace) => readonly LanguageBackend[];
}

/**
 * The fully-defaulted variant of `BuildProgramOptions`. Used internally so each
 * call site can rely on every field being defined.
 */
export type ProgramContext = Required<BuildProgramOptions>;

function resolveContext(options: BuildProgramOptions | undefined): ProgramContext {
  return {
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    cwd: options?.cwd ?? process.cwd(),
    exit: options?.exit ?? ((code: number) => process.exit(code)),
    backendsFor: options?.backendsFor ?? defaultBackendsFor,
  };
}

// Real-backend default. Tests pass a fake via `backendsFor`.
function defaultBackendsFor(workspace: Workspace): readonly LanguageBackend[] {
  return [new TypeScriptBackend(workspace)];
}

export function buildProgram(options?: BuildProgramOptions): Command {
  const context = resolveContext(options);
  const program = new Command();
  program
    .name("symnav")
    .version(readPackageVersion(), "-v, --version")
    .option(
      "--cwd <dir>",
      "override the working directory for root detection and relative-path resolution",
    )
    .configureOutput({
      writeOut: (str) => context.stdout.write(str),
      writeErr: (str) => context.stderr.write(str),
    })
    .exitOverride((err) => {
      context.exit(err.exitCode);
    })
    .action(() => {
      program.outputHelp({ error: true });
      context.exit(1);
    });
  registerOverviewCommand(program, context);
  return program;
}
