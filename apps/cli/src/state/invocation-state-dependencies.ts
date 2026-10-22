import type {
  TelemetryFailureObserver,
  TelemetryWriteFailure,
  UsageEventInput,
  Recorder,
} from "@symnav/telemetry";
import type { ProgramDependencies } from "../program-dependencies.js";
import type {
  TelemetryIdentity,
  TelemetryIdentityInput,
  TelemetryIdentityProvider,
} from "../telemetry/telemetry-identity.js";
import type { InvocationStateWriteCoordinator } from "./state-write-coordinator.js";

export class InvocationStateDependencies
  implements TelemetryFailureObserver, Recorder, TelemetryIdentityProvider
{
  private readonly telemetry: Pick<ProgramDependencies, "recorder" | "identity">;

  private constructor(
    dependencies: ProgramDependencies,
    private readonly coordinator: InvocationStateWriteCoordinator,
  ) {
    this.telemetry = dependencies.invocationTelemetry?.(this) ?? dependencies;
  }

  public static create(
    dependencies: ProgramDependencies,
    coordinator: InvocationStateWriteCoordinator,
    telemetryEnabled: boolean,
  ): ProgramDependencies {
    const invocation = new InvocationStateDependencies(dependencies, coordinator);
    return {
      ...dependencies,
      recorder: invocation,
      identity: invocation,
      telemetryEnabled: telemetryEnabled && coordinator.access.kind !== "disabled",
    };
  }

  public writeFailed(failure: TelemetryWriteFailure): void {
    this.coordinator.failed(
      failure.path,
      failure.osCode === undefined ? undefined : { code: failure.osCode },
    );
  }

  public record(input: UsageEventInput): void {
    if (this.coordinator.access.kind === "disabled") return;
    this.telemetry.recorder.record(input);
  }

  public resolve(input: TelemetryIdentityInput): TelemetryIdentity {
    if (this.coordinator.access.kind === "disabled")
      throw new Error("Invocation state writes are disabled");
    return this.telemetry.identity.resolve(input);
  }
}
