import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  type LanguageBackend,
  type Workspace,
  type WorkspaceFileSystem,
  createWorkspace,
  nodeFileSystem,
} from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { registerOverviewCommand } from "./commands/overview.js";

export interface BuildProgramOptions {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  cwd?: string;
  exit?: (code: number) => never;
  createWorkspace?: (startDir: string) => Promise<Workspace>;
  buildBackends?: (workspace: Workspace) => readonly LanguageBackend[];
}

export interface ResolvedProgramContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd: string;
  exit: (code: number) => never;
  createWorkspace: (startDir: string) => Promise<Workspace>;
  buildBackends: (workspace: Workspace) => readonly LanguageBackend[];
}

function defaultCreateWorkspace(startDir: string): Promise<Workspace> {
  const fs: WorkspaceFileSystem = nodeFileSystem();
  return createWorkspace({ startDir, fs });
}

function defaultBuildBackends(workspace: Workspace): readonly LanguageBackend[] {
  return [new TypeScriptBackend(workspace)];
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

export function buildProgram(options: BuildProgramOptions = {}): Command {
  const context: ResolvedProgramContext = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    cwd: options.cwd ?? process.cwd(),
    exit: options.exit ?? ((code: number) => process.exit(code) as never),
    createWorkspace: options.createWorkspace ?? defaultCreateWorkspace,
    buildBackends: options.buildBackends ?? defaultBuildBackends,
  };

  const program = new Command();
  program
    .name("symnav")
    .version(readPackageVersion(), "-v, --version")
    .option("--cwd <dir>", "override working directory for path resolution and workspace detection")
    .action(() => {
      program.outputHelp({ error: true });
      context.exit(1);
    });

  registerOverviewCommand(program, context);

  return program;
}
