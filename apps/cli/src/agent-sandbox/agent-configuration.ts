export type SupportedAgent = "codex" | "claude-code";

export interface AgentSetupResult {
  readonly agent: SupportedAgent;
  readonly stateDirectory: string;
  readonly configurationPath: string;
  readonly changed: boolean;
  readonly installed: boolean;
}

export interface AgentConfigurationLocations {
  readonly homeDirectory: string;
  readonly codexHome?: string;
  readonly claudeConfigurationDirectory?: string;
}

export abstract class AgentSandboxConfiguration {
  public abstract readonly agent: SupportedAgent;
  public abstract readonly configurationPath: string;
  public abstract grant(stateDirectory: string): Promise<AgentSetupResult>;
}
