import type { DaemonProcessTerminator } from "./daemon-process-launcher.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonPong, type DaemonRecord } from "./daemon-protocol.js";
import { DaemonTransportError, type LocalDaemonTransport } from "./local-daemon-transport.js";

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

export class DaemonRecordObserver {
  constructor(
    private readonly transport: LocalDaemonTransport,
    private readonly processTerminator: DaemonProcessTerminator,
    _now: () => number = Date.now,
  ) {}

  async observe(record: DaemonRecord): Promise<DaemonObservation> {
    if (record.state === "starting") {
      if (record.pid > 0 && !this.processTerminator.isAlive(record.pid)) {
        return { kind: "exited", record };
      }
      return { kind: "starting", record };
    }
    if (!this.processTerminator.isAlive(record.pid)) return { kind: "exited", record };

    const authenticated = await this.authenticate(record);
    if (!authenticated) {
      return this.processTerminator.isAlive(record.pid)
        ? { kind: "unresponsive", record, failureCode: "authentication" }
        : { kind: "exited", record };
    }

    try {
      const response = await this.transport.request(record.endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
      });
      if (response.kind !== "pong") {
        return { kind: "corrupt", record, evidence: DaemonRecordObserver.evidence(record) };
      }
      if (response.symnavVersion !== record.symnavVersion) {
        return { kind: "incompatible", record, evidence: DaemonRecordObserver.evidence(record) };
      }
      if (response.startedAt !== undefined && response.startedAt !== record.startedAt) {
        return { kind: "corrupt", record, evidence: DaemonRecordObserver.evidence(record) };
      }
      return { kind: "responsive", record, pong: response };
    } catch (error) {
      if (!this.processTerminator.isAlive(record.pid)) return { kind: "exited", record };
      if (
        error instanceof DaemonTransportError &&
        error.authenticatedInstanceId === record.instanceId
      ) {
        if (error.code === "incompatible") {
          return {
            kind: "incompatible",
            record,
            evidence: DaemonRecordObserver.evidence(record),
          };
        }
        if (error.code === "corrupt") {
          return { kind: "corrupt", record, evidence: DaemonRecordObserver.evidence(record) };
        }
      }
      return {
        kind: "unresponsive",
        record,
        failureCode: error instanceof DaemonTransportError ? error.code : "unknown",
      };
    }
  }

  private async authenticate(record: DaemonRecord): Promise<boolean> {
    try {
      const response = await this.transport.request(record.endpoint, {
        kind: "identify",
        instanceId: record.instanceId,
        processToken: record.processToken,
      });
      return (
        response.kind === "identity" &&
        response.pid === record.pid &&
        response.startedAt === record.startedAt
      );
    } catch {
      return false;
    }
  }

  private static evidence(record: DaemonRecord): DaemonIdentityEvidence {
    return {
      instanceId: record.instanceId,
      processToken: record.processToken,
      pid: record.pid,
      startedAt: record.startedAt,
    };
  }
}
