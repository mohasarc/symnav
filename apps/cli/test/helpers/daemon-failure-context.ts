import { realpathSync } from "node:fs";
import type { RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "./canonical-workspace-root.js";
import type { ControlledLifecycleDaemon } from "./controlled-lifecycle-daemon.js";
import { CliDaemonTesting } from "./daemon-testing.js";
import { DaemonDiagnosticEvidence } from "./daemon-diagnostic-evidence.js";

interface DaemonFailureContextOptions {
  readonly stateDirectory: string;
  readonly workspaceRoot: string;
  readonly result: RunSymnavBinaryResult;
  readonly elapsedMs?: number;
  readonly actor?: ControlledLifecycleDaemon;
}

export class DaemonFailureContext {
  public constructor(private readonly options: DaemonFailureContextOptions) {}

  public async assert<T>(assertion: () => T | Promise<T>): Promise<T> {
    try {
      return await assertion();
    } catch (error) {
      if (error instanceof Error) {
        const context = await this.capture();
        error.message += `\nDaemon failure context: ${context}`;
      }
      throw error;
    }
  }

  private async capture(): Promise<string> {
    const { stateDirectory, result, elapsedMs, actor } = this.options;
    const actorSnapshot = await this.observe(() => actor?.diagnosticSnapshot());
    const inspector = await this.observe(() => new CliDaemonTesting(stateDirectory).inspector);
    const root = await this.observe(() =>
      canonicalWorkspaceRoot(realpathSync(this.options.workspaceRoot)),
    );
    const instances =
      "unavailable" in inspector ? inspector : await this.observe(() => inspector.listInstances());
    const diagnostics =
      "unavailable" in inspector
        ? inspector
        : typeof root === "string"
          ? await this.observe(() =>
              inspector
                .readDiagnostics(root)
                .events.map((event) => DaemonDiagnosticEvidence.event(event)),
            )
          : root;
    const failures =
      "unavailable" in inspector
        ? inspector
        : typeof root === "string"
          ? await this.observe(async () =>
              (await inspector.readFailures(root)).map((event) =>
                DaemonDiagnosticEvidence.event({ ...event }),
              ),
            )
          : root;
    return JSON.stringify({
      result,
      elapsedMs,
      actor: actorSnapshot,
      instances,
      diagnostics,
      failures,
    });
  }

  private async observe<T>(
    read: () => T | Promise<T>,
  ): Promise<T | { readonly unavailable: true; readonly osCode?: string }> {
    try {
      return await read();
    } catch (error) {
      const osCode = DaemonDiagnosticEvidence.osCode(
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
      );
      return { unavailable: true, ...(osCode === undefined ? {} : { osCode }) };
    }
  }
}
