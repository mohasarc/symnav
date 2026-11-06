import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NodeTelemetryWritePort } from "./node-telemetry-write-port.js";
import { NodeUsageRecorder } from "./recorder.js";
import type { UsageEventInput } from "./recorder.js";

describe("NodeTelemetryWritePort", () => {
  it("reports a failed actual append once without throwing out of the recorder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-telemetry-denied-"));
    try {
      const path = join(directory, "usage.jsonl");
      await mkdir(path);
      const writeFailed = vi.fn();
      const recorder = new NodeUsageRecorder(new NodeTelemetryWritePort(path, { writeFailed }), {
        next: () => "session",
      });
      const input = { command: "overview" } as UsageEventInput;
      expect(() => recorder.record(input)).not.toThrow();
      await rm(path, { recursive: true });
      recorder.record(input);
      expect(writeFailed).toHaveBeenCalledTimes(1);
      expect(writeFailed).toHaveBeenCalledWith({ path, osCode: "EISDIR" });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
