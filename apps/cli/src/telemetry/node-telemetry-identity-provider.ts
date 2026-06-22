import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GitRemoteReader,
  type IdentityAnomalySink,
  MAX_MACHINE_ID_LENGTH,
  type TelemetryIdentity,
  type TelemetryIdentityInput,
  type TelemetryIdentityProvider,
} from "./telemetry-identity.js";

export class NodeGitRemoteReader implements GitRemoteReader {
  public read(workspaceRoot: string): string | undefined {
    try {
      return execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
}

export class NodeTelemetryIdentityProvider implements TelemetryIdentityProvider {
  public constructor(
    private readonly stateDir: string,
    private readonly gitRemoteReader: GitRemoteReader,
    private readonly anomalySink: IdentityAnomalySink = noopAnomalySink,
  ) {}

  public resolve(input: TelemetryIdentityInput): TelemetryIdentity {
    return {
      workspaceId: this.workspaceIdFor(input),
      machineId: this.readMachineId(),
    };
  }

  private workspaceIdFor(input: TelemetryIdentityInput): string {
    const workspaceSource =
      input.workspaceRoot === undefined
        ? input.cwd
        : (this.gitRemoteReader.read(input.workspaceRoot) ?? input.workspaceRoot);

    return stableHash(workspaceSource);
  }

  private readMachineId(): string {
    const machineIdPath = join(this.stateDir, "machine-id");

    if (existsSync(machineIdPath)) {
      const machineId = readFileSync(machineIdPath, "utf8").trim();
      if (machineId.length > MAX_MACHINE_ID_LENGTH) {
        this.anomalySink.record({ kind: "machine_id_over_max_length", length: machineId.length });
      }
      return machineId;
    }

    const machineId = randomUUID();
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(machineIdPath, machineId, "utf8");
    return machineId;
  }
}

const noopAnomalySink: IdentityAnomalySink = { record: () => undefined };

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
