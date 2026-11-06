import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { InvocationStateAccess, InvocationStateRequirements } from "./state-write-failure.js";

export class InvocationStateWriteCoordinator {
  private current: InvocationStateAccess = { kind: "unused" };

  public constructor(private readonly stateDirectory: string) {}

  public get access(): InvocationStateAccess {
    return this.current;
  }

  public async prepare(requirements: InvocationStateRequirements): Promise<InvocationStateAccess> {
    if (this.current.kind !== "unused" || (!requirements.daemon && !requirements.telemetry))
      return this.current;
    let operationPath = this.stateDirectory;
    try {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      if (requirements.telemetry) {
        operationPath = join(this.stateDirectory, "usage.jsonl");
        await (await open(operationPath, "a", 0o600)).close();
      }
      if (requirements.daemon) {
        for (const directory of ["daemons", "captures"]) {
          operationPath = join(this.stateDirectory, directory);
          await mkdir(operationPath, { recursive: true, mode: 0o700 });
          operationPath = join(operationPath, `.write-${randomUUID()}`);
          await (await open(operationPath, "wx", 0o600)).close();
          await unlink(operationPath);
        }
      }
      this.current = { kind: "available" };
    } catch (error) {
      this.failed(operationPath, error);
    }
    return this.current;
  }

  public failed(path: string, error: unknown): void {
    if (this.current.kind === "disabled") return;
    const osCode = this.osCode(error);
    this.current = {
      kind: "disabled",
      failure: {
        stateDirectory: this.stateDirectory,
        operationPath: path,
        ...(osCode === undefined ? {} : { osCode }),
      },
    };
  }

  public renderWarning(): string | undefined {
    if (this.current.kind !== "disabled") return undefined;
    const { stateDirectory, osCode } = this.current.failure;
    const code = osCode === undefined ? "" : ` (${osCode})`;
    return `symnav: warning: cannot write ${stateDirectory}${code}; daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.\n`;
  }

  private osCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
  }
}
