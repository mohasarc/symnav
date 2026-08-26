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

export type DaemonIdentityObservation =
  | { readonly kind: "starting"; readonly record: DaemonRecord }
  | { readonly kind: "authenticated"; readonly record: DaemonRecord }
  | {
      readonly kind: "unresponsive";
      readonly record: DaemonRecord;
      readonly failureCode: "authentication";
    }
  | { readonly kind: "exited"; readonly record: DaemonRecord };

export class DaemonRecordObserver {
  constructor(
    private readonly transport: LocalDaemonTransport,
    private readonly processTerminator: DaemonProcessTerminator,
    _now: () => number = Date.now,
  ) {}

  async observeIdentity(record: DaemonRecord): Promise<DaemonIdentityObservation> {
    if (record.state === "starting") {
      if (record.pid > 0 && !this.processTerminator.isAlive(record.pid)) {
        return { kind: "exited", record };
      }
      return { kind: "starting", record };
    }
    if (!this.processTerminator.isAlive(record.pid)) return { kind: "exited", record };
    const authenticated = await this.authenticate(record);
    if (!this.processTerminator.isAlive(record.pid)) return { kind: "exited", record };
    return authenticated
      ? { kind: "authenticated", record }
      : { kind: "unresponsive", record, failureCode: "authentication" };
  }

  async observe(record: DaemonRecord): Promise<DaemonObservation> {
    if (record.state === "starting" && record.pid <= 0) return { kind: "starting", record };
    if (!this.processTerminator.isAlive(record.pid)) return { kind: "exited", record };

    const [authenticated, ping] = await Promise.all([
      this.authenticate(record),
      this.transport
        .request(record.endpoint, {
          kind: "ping",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          instanceId: record.instanceId,
        })
        .then(
          (response) => ({ kind: "response" as const, response }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
    ]);
    if (!this.processTerminator.isAlive(record.pid)) return { kind: "exited", record };
    if (!authenticated) {
      if (record.state === "starting") return { kind: "starting", record };
      return { kind: "unresponsive", record, failureCode: "authentication" };
    }

    if (ping.kind === "response") {
      const response = ping.response;
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
    }

    const error = ping.error;
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
