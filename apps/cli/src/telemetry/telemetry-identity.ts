export interface TelemetryIdentity {
  readonly workspaceId: string;
  readonly machineId: string;
}

export const MAX_MACHINE_ID_LENGTH = 36;

export interface IdentityAnomaly {
  readonly kind: "machine_id_over_max_length";
  readonly length: number;
}

export interface IdentityAnomalySink {
  record(anomaly: IdentityAnomaly): void;
}

export interface GitRemoteReader {
  read(workspaceRoot: string): string | undefined;
}

export interface TelemetryIdentityInput {
  readonly cwd: string;
  readonly workspaceRoot: string | undefined;
}

export interface TelemetryIdentityProvider {
  resolve(input: TelemetryIdentityInput): TelemetryIdentity;
}
