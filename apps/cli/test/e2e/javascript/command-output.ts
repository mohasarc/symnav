import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSymnavBinaryResult } from "@symnav/testing";
import { expect } from "vitest";

export class CommandOutput {
  private static readonly snapshotsDirectory = fileURLToPath(
    new URL("./__snapshots__/", import.meta.url),
  );

  static async expectSnapshot(result: RunSymnavBinaryResult, snapshotName: string): Promise<void> {
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    await expect(result.stdout).toMatchFileSnapshot(
      join(CommandOutput.snapshotsDirectory, `${snapshotName}.expected.txt`),
    );
  }
}
