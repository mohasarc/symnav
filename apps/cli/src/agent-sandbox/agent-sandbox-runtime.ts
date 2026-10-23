import type { SupportedAgent } from "./agent-configuration.js";
import type { AgentProbePolicy } from "./agent-probe-policy.js";

export interface SandboxProbeRequest {
  readonly scratchDirectory: string;
  readonly workspace: string;
  readonly stateDirectory: string;
  readonly policy: AgentProbePolicy;
  readonly signal?: AbortSignal;
}

export abstract class AgentSandboxRuntime {
  public abstract readonly agent: SupportedAgent;
  public abstract availability(): Promise<"available" | "not-found" | "not-exposable">;
  public abstract probe(request: SandboxProbeRequest): Promise<void>;
}
