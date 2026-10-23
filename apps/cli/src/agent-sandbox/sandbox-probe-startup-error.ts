import type { DaemonStartupFailureStatus } from "@symnav/daemon";

export class SandboxProbeStartupError extends Error {
  public constructor(public readonly startupFailure: DaemonStartupFailureStatus) {
    const { failure, workspaceRoot } = startupFailure;
    const osCode = failure.osCode === undefined ? "" : `; OS code: ${failure.osCode}`;
    super(
      `sandbox daemon warm-up failed (phase: ${failure.phase}; reason: ${failure.reason}${osCode}; workspace: ${workspaceRoot})`,
    );
  }
}
