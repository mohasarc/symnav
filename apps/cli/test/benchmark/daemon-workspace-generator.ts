import type { DaemonWorkspaceProfile } from "./daemon-workspace-profile.js";

export type DaemonBenchmarkScale = 1 | 2 | 3 | 10;

export interface DaemonWorkspaceGeneratorOptions {
  readonly profile: DaemonWorkspaceProfile;
  readonly generatorVersion: string;
  readonly seed: string;
  readonly scale: DaemonBenchmarkScale;
}

export interface DaemonBenchmarkCommand {
  readonly argv: readonly string[];
  readonly expectNonEmpty: boolean;
}

export interface DaemonBenchmarkCommandSuite {
  readonly overview: DaemonBenchmarkCommand;
  readonly resolve: DaemonBenchmarkCommand;
  readonly def: DaemonBenchmarkCommand;
  readonly refs: DaemonBenchmarkCommand;
  readonly context: DaemonBenchmarkCommand;
  readonly graph: DaemonBenchmarkCommand;
  readonly stats: DaemonBenchmarkCommand;
}

export interface DaemonBenchmarkMutationSuite {
  readonly sameSizeEdit: string;
  readonly add: string;
  readonly remove: string;
  readonly renameFrom: string;
  readonly renameTo: string;
  readonly ignoreRule: string;
  readonly nestedWorkspaceFile: string;
}

export interface GeneratedDaemonWorkspace {
  readonly workspaceRoot: string;
  readonly commands: DaemonBenchmarkCommandSuite;
  readonly mutations: DaemonBenchmarkMutationSuite;
  readonly expectedProfile: DaemonWorkspaceProfile;
}

export class DaemonWorkspaceGenerator {
  constructor(private readonly options: DaemonWorkspaceGeneratorOptions) {}

  generate(_destination: string): Promise<GeneratedDaemonWorkspace> {
    return Promise.reject(new Error("Daemon workspace generation is not implemented"));
  }
}
