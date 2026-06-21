import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TelemetryIdentity {
  readonly workspaceId: string;
  readonly machineId: string;
}

export interface GitRemoteReader {
  read(workspaceRoot: string): string | undefined;
}

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

export interface TelemetryIdentityProvider {
  resolve(input: { cwd: string; workspaceRoot: string | undefined }): TelemetryIdentity;
}

export class NodeTelemetryIdentityProvider implements TelemetryIdentityProvider {
  public constructor(
    private readonly stateDir: string,
    private readonly gitRemoteReader: GitRemoteReader,
  ) {}

  public resolve(input: { cwd: string; workspaceRoot: string | undefined }): TelemetryIdentity {
    return {
      workspaceId: this.workspaceIdFor(input),
      machineId: this.readMachineId(),
    };
  }

  private workspaceIdFor(input: { cwd: string; workspaceRoot: string | undefined }): string {
    const workspaceSource =
      input.workspaceRoot === undefined
        ? input.cwd
        : (this.gitRemoteReader.read(input.workspaceRoot) ?? input.workspaceRoot);

    return stableHash(workspaceSource);
  }

  private readMachineId(): string {
    const machineIdPath = join(this.stateDir, "machine-id");

    if (existsSync(machineIdPath)) {
      return readFileSync(machineIdPath, "utf8");
    }

    const machineId = randomUUID();
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(machineIdPath, machineId, "utf8");
    return machineId;
  }
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
