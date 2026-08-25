import type { DaemonPong, DaemonRecord } from "./daemon-protocol.js";

export interface DaemonIdentityEvidence {
  readonly instanceId: string;
  readonly processToken: string;
  readonly pid: number;
  readonly startedAt: number;
}

export type DaemonObservation =
  | { readonly kind: "starting"; readonly record: DaemonRecord }
  | { readonly kind: "responsive"; readonly record: DaemonRecord; readonly pong: DaemonPong }
  | {
      readonly kind: "unresponsive";
      readonly record: DaemonRecord;
      readonly failureCode: string;
    }
  | { readonly kind: "exited"; readonly record: DaemonRecord }
  | {
      readonly kind: "incompatible";
      readonly record: DaemonRecord;
      readonly evidence: DaemonIdentityEvidence;
    }
  | {
      readonly kind: "corrupt";
      readonly record: DaemonRecord;
      readonly evidence: DaemonIdentityEvidence;
};
