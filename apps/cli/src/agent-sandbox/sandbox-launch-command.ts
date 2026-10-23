export interface SandboxLaunchCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}
