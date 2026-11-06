import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvocationStateWriteCoordinator } from "./state-write-coordinator.js";

class StateHarness {
  private static directories: string[] = [];

  public static async directory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "symnav-state-write-"));
    this.directories.push(directory);
    return directory;
  }

  public static async cleanup(): Promise<void> {
    for (const directory of this.directories) {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
    this.directories = [];
  }
}

afterEach(() => StateHarness.cleanup());

describe("InvocationStateWriteCoordinator", () => {
  it("does not inspect or create state when neither operation needs it", async () => {
    const directory = await StateHarness.directory();
    const state = join(directory, "missing");
    const coordinator = new InvocationStateWriteCoordinator(state);
    expect(await coordinator.prepare({ daemon: false, telemetry: false })).toEqual({
      kind: "unused",
    });
    expect(await readdir(directory)).toEqual([]);
    expect(coordinator.renderWarning()).toBeUndefined();
  });

  it("prepares only daemon directories when telemetry is off", async () => {
    const directory = await StateHarness.directory();
    const coordinator = new InvocationStateWriteCoordinator(directory);
    expect(await coordinator.prepare({ daemon: true, telemetry: false })).toEqual({
      kind: "available",
    });
    expect((await readdir(directory)).sort()).toEqual(["captures", "daemons"]);
  });

  it("checks actual telemetry targets without changing their contents", async () => {
    const directory = await StateHarness.directory();
    await writeFile(join(directory, "usage.jsonl"), "existing\n");
    await writeFile(join(directory, "machine-id"), "identity");
    const coordinator = new InvocationStateWriteCoordinator(directory);
    expect(await coordinator.prepare({ daemon: false, telemetry: true })).toEqual({
      kind: "available",
    });
    expect(await readFile(join(directory, "usage.jsonl"), "utf8")).toBe("existing\n");
    expect(await readFile(join(directory, "machine-id"), "utf8")).toBe("identity");
    expect((await readdir(directory)).sort()).toEqual(["machine-id", "usage.jsonl"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not require writes to an existing readable identity",
    async () => {
      const directory = await StateHarness.directory();
      const identity = join(directory, "machine-id");
      await writeFile(identity, "identity");
      await chmod(identity, 0o400);
      const coordinator = new InvocationStateWriteCoordinator(directory);
      expect(await coordinator.prepare({ daemon: false, telemetry: true })).toEqual({
        kind: "available",
      });
      expect(await readFile(identity, "utf8")).toBe("identity");
      expect(coordinator.renderWarning()).toBeUndefined();
    },
  );

  it("retains actual append-open preparation results for a usage directory", async () => {
    const directory = await StateHarness.directory();
    const path = join(directory, "usage.jsonl");
    await mkdir(path);
    const coordinator = new InvocationStateWriteCoordinator(directory);
    expect(await coordinator.prepare({ daemon: false, telemetry: true })).toEqual(
      process.platform === "win32"
        ? { kind: "available" }
        : {
            kind: "disabled",
            failure: { stateDirectory: directory, operationPath: path, osCode: "EISDIR" },
          },
    );
  });

  it.each(["EPERM", "EACCES", "ENOSPC", undefined])(
    "retains the first actual failure (%s) and never retries",
    async (code) => {
      const directory = await StateHarness.directory();
      const state = join(directory, "missing");
      const coordinator = new InvocationStateWriteCoordinator(state);
      coordinator.failed(
        join(state, "usage.jsonl"),
        Object.assign(new Error("denied"), code === undefined ? {} : { code }),
      );
      coordinator.failed("later", Object.assign(new Error("later"), { code: "EIO" }));
      expect(await coordinator.prepare({ daemon: true, telemetry: true })).toEqual({
        kind: "disabled",
        failure: {
          stateDirectory: state,
          operationPath: join(state, "usage.jsonl"),
          ...(code === undefined ? {} : { osCode: code }),
        },
      });
      expect(coordinator.renderWarning()).toBe(
        `symnav: warning: cannot write ${state}${code === undefined ? "" : ` (${code})`}; daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.\n`,
      );
      expect(await readdir(directory)).toEqual([]);
    },
  );
});
