export interface AgentProbePolicy {
  readonly grantsState: boolean;
  readonly configuration: string;
  readonly disabledReason?: string;
}
