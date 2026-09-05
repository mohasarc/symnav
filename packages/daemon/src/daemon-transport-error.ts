import { DaemonAdmissionRejections, type DaemonExecuteRejectionCode } from "@symnav/daemon";

export type DaemonDeliveryState = "not-submitted" | "submitted-unconfirmed" | "accepted";

export type DaemonTransportFailureCode =
  | "unreachable"
  | "timeout"
  | "corrupt"
  | "incompatible"
  | "authentication"
  | "closed"
  | "rejected";

export class DaemonTransportError extends Error {
  readonly authenticatedInstanceId?: string;
  readonly retrySafe: boolean;

  constructor(
    readonly code: DaemonTransportFailureCode,
    readonly delivery: DaemonDeliveryState,
    message: string,
    authenticatedInstanceId?: string,
    authenticatedRejectionCode?: DaemonExecuteRejectionCode,
  ) {
    super(message);
    this.name = "DaemonTransportError";
    if (authenticatedInstanceId !== undefined) {
      this.authenticatedInstanceId = authenticatedInstanceId;
    }
    this.retrySafe =
      delivery === "not-submitted" ||
      (code === "rejected" &&
        delivery === "submitted-unconfirmed" &&
        authenticatedInstanceId !== undefined &&
        authenticatedRejectionCode !== undefined &&
        DaemonAdmissionRejections.retrySafe(authenticatedRejectionCode));
  }
}
