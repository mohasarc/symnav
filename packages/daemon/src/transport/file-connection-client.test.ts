import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import { FileDaemonEndpoint } from "./file-endpoint.js";
import { FileDaemonConnectionClient } from "./file-connection-client.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) };
});

describe("FileDaemonConnectionClient write provenance", () => {
  afterEach(() => vi.restoreAllMocks());

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a real cleanup write failure after an ownership read fails",
    async () => {
      const endpoint = await files.mkdtemp(join(tmpdir(), "symnav-channel-cleanup-"));
      const owner = join(endpoint, "owner.json");
      await files.writeFile(owner, JSON.stringify({ pid: process.pid }));
      const readOwner = FileDaemonEndpoint.ownerPid.bind(FileDaemonEndpoint);
      let channel: string | undefined;
      vi.spyOn(FileDaemonEndpoint, "ownerPid")
        .mockImplementationOnce(readOwner)
        .mockImplementationOnce(async (directory) => {
          const temporary = (await files.readdir(endpoint)).find((entry) => entry.endsWith(".tmp"));
          channel = join(endpoint, temporary!);
          await files.chmod(channel, 0o500);
          await files.rm(owner);
          return readOwner(directory);
        });
      try {
        const client = new FileDaemonConnectionClient({
          policy: DaemonPolicy.currentSystem().values.transport,
        });
        const error: unknown = await client.connect(endpoint).catch((cause: unknown) => cause);
        expect(DaemonStateWriteErrors.from(error)).toEqual({
          path: expect.stringContaining(channel!),
          osCode: "EACCES",
        });
        expect(await files.readdir(channel!)).toEqual(["owner.json", "request", "response"]);
      } finally {
        if (channel !== undefined) await files.chmod(channel, 0o700);
        await files.rm(endpoint, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "retains the first writable-open failure when cleanup also fails (%s)",
    async (cleanupFails) => {
      const endpoint = await files.mkdtemp(join(tmpdir(), "symnav-channel-write-"));
      await files.writeFile(join(endpoint, "owner.json"), JSON.stringify({ pid: process.pid }));
      const failure = Object.assign(new Error("denied"), { code: "EPERM", syscall: "open" });
      vi.mocked(files.writeFile).mockRejectedValueOnce(failure);
      if (cleanupFails)
        vi.mocked(files.rm).mockRejectedValueOnce(
          Object.assign(new Error("cleanup denied"), { code: "EACCES", syscall: "unlink" }),
        );
      try {
        const client = new FileDaemonConnectionClient({
          policy: DaemonPolicy.currentSystem().values.transport,
        });
        const error: unknown = await client.connect(endpoint).catch((cause: unknown) => cause);
        expect(DaemonStateWriteErrors.from(error)).toEqual({
          path: expect.stringContaining(endpoint),
          osCode: "EPERM",
        });
        expect((error as Error).cause).toBe(failure);
        const remaining = await files.readdir(endpoint);
        expect(remaining).toContain("owner.json");
        expect(remaining.filter((entry) => entry.endsWith(".tmp"))).toHaveLength(
          cleanupFails ? 1 : 0,
        );
      } finally {
        await files.rm(endpoint, { recursive: true, force: true });
      }
    },
  );
});
