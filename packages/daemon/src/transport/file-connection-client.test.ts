import * as files from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
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

describe.skipIf(process.platform === "win32")("FileDaemonConnectionClient write provenance", () => {
  afterEach(() => vi.restoreAllMocks());

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a real cleanup write failure after an ownership read fails",
    async () => {
      const fixture = await ChannelWriteFixture.create();
      const { endpoint, directory, owner } = fixture;
      const readOwner = FileDaemonEndpoint.owner.bind(FileDaemonEndpoint);
      let channel: string | undefined;
      vi.spyOn(FileDaemonEndpoint, "owner")
        .mockImplementationOnce(readOwner)
        .mockImplementationOnce(async (requestedEndpoint) => {
          const temporary = (await files.readdir(directory)).find((entry) =>
            entry.endsWith(".tmp"),
          );
          channel = join(directory, temporary!);
          expect(await files.readdir(channel)).toEqual(["owner.json", "request", "response"]);
          await files.chmod(channel, 0o500);
          await files.rm(owner);
          return readOwner(requestedEndpoint);
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
        expect(DaemonStateWriteErrors.from(error)!.path).toBe(
          ((error as Error).cause as NodeJS.ErrnoException).path,
        );
        expect(await files.readdir(channel!)).toEqual(["owner.json", "request", "response"]);
      } finally {
        if (channel !== undefined) await files.chmod(channel, 0o700);
        await fixture.dispose();
      }
    },
  );

  it("does not turn an ownership read failure into a write failure", async () => {
    const fixture = await ChannelWriteFixture.create();
    const failure = Object.assign(new Error("read denied"), {
      path: fixture.owner,
      code: "EACCES",
      syscall: "open",
    });
    const readOwner = FileDaemonEndpoint.owner.bind(FileDaemonEndpoint);
    vi.spyOn(FileDaemonEndpoint, "owner")
      .mockImplementationOnce(readOwner)
      .mockRejectedValueOnce(failure);
    try {
      const client = new FileDaemonConnectionClient({
        policy: DaemonPolicy.currentSystem().values.transport,
      });
      const error: unknown = await client
        .connect(fixture.endpoint)
        .catch((cause: unknown) => cause);
      expect(error).toBe(failure);
      expect(DaemonStateWriteErrors.from(error)).toBeUndefined();
      expect(await files.readdir(fixture.directory)).toEqual(["owner.json"]);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([false, true])(
    "retains the first writable-open failure when cleanup also fails (%s)",
    async (cleanupFails) => {
      const fixture = await ChannelWriteFixture.create();
      const { endpoint, directory } = fixture;
      const failure = Object.assign(new Error("denied"), {
        code: "EPERM",
        syscall: "open",
        path: "",
      });
      vi.mocked(files.writeFile).mockImplementationOnce(async (path) => {
        failure.path = String(path);
        throw failure;
      });
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
          path: failure.path,
          osCode: "EPERM",
        });
        expect((error as Error).cause).toBe(failure);
        const remaining = await files.readdir(directory);
        expect(remaining).toContain("owner.json");
        expect(remaining.filter((entry) => entry.endsWith(".tmp"))).toHaveLength(
          cleanupFails ? 1 : 0,
        );
      } finally {
        await fixture.dispose();
      }
    },
  );
});

class ChannelWriteFixture {
  private constructor(
    public readonly state: string,
    public readonly endpoint: string,
    public readonly directory: string,
  ) {}
  public get owner(): string {
    return join(this.directory, "owner.json");
  }
  public static async create(): Promise<ChannelWriteFixture> {
    const state = await files.mkdtemp(join(tmpdir(), "symnav-channel-write-"));
    const endpoint = join(state, "endpoint");
    const token = randomUUID();
    const directory = join(endpoint, token);
    await files.mkdir(directory, { recursive: true, mode: 0o700 });
    await files.writeFile(
      join(directory, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token,
        processLifetime: PosixDaemonProcessLifetime.current(state),
      }),
    );
    return new ChannelWriteFixture(state, endpoint, directory);
  }
  public async dispose(): Promise<void> {
    await files.rm(this.state, { recursive: true, force: true });
  }
}
