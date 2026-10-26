import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NodeTelemetryIdentityProvider } from "./node-telemetry-identity-provider.js";

describe("NodeTelemetryIdentityProvider write failure", () => {
  it("reports the actual identity creation failure before the caller suppresses it", () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-identity-failure-"));
    try {
      const state = join(directory, "state");
      writeFileSync(state, "blocked");
      const writeFailed = vi.fn();
      const provider = new NodeTelemetryIdentityProvider(
        state,
        { read: () => undefined },
        undefined,
        { writeFailed },
      );
      expect(() => provider.resolve({ cwd: directory, workspaceRoot: undefined })).toThrow();
      expect(writeFailed).toHaveBeenCalledTimes(1);
      expect(writeFailed).toHaveBeenCalledWith({
        path: join(state, "machine-id"),
        osCode: "EEXIST",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
