import { access, chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import * as completionSpoolModule from "./completion-spool.js";

describe("DaemonCompletionSpoolStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses the required output-policy capacities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-policy-"));
    roots.push(directory);
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: 1024 ** 3 }),
      {
        output: {
          maximumChunkRawBytes: 2,
          inlineRawBytes: 3,
          maximumResultRawBytes: 6,
          maximumAggregateSpoolRawBytes: 9,
        },
      },
    );
    const store = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      policy: policy.values.output,
    } as unknown as ConstructorParameters<
      typeof completionSpoolModule.DaemonCompletionSpoolStore
    >[0]);
    const spool = await store.create("request-a");

    await expect(
      spool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("123") }),
    ).rejects.toThrow(/chunk capacity/i);
  });

  it("spills threshold-plus-one output securely and acknowledges exact completion cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-spool-"));
    roots.push(directory);
    const store = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      policy: outputPolicy({
        maximumChunkRawBytes: 8,
        inlineRawBytes: 8,
        maximumResultRawBytes: 64,
        maximumAggregateSpoolRawBytes: 128,
      }),
    });
    const spool = await store.create("request-a");
    await spool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("12345678") });
    await spool.append({ sequence: 1, stream: "stderr", bytes: Buffer.from("x") });
    const manifest = await spool.finish(3);

    expect(manifest).toMatchObject({
      requestId: "request-a",
      instanceId: "instance-a",
      exitCode: 3,
      rawBytes: 9,
      recordCount: 2,
    });
    expect(manifest.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(store.usage()).toEqual({ rawBytes: 9, completionCount: 1 });
    const instanceEntries = await readdir(join(directory, "instance-a"));
    expect(instanceEntries).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "instance-a", instanceEntries[0]!))).mode & 0o777).toBe(
        0o600,
      );
    }
    const records = [];
    for await (const record of spool.read(1)) records.push(record);
    expect(records).toEqual([{ sequence: 1, stream: "stderr", bytes: Buffer.from("x") }]);

    await spool.acknowledge();
    expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    await expect(access(join(directory, "instance-a", instanceEntries[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed on aggregate capacity and never evicts an earlier completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-capacity-"));
    roots.push(directory);
    const store = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      policy: outputPolicy({
        maximumChunkRawBytes: 6,
        inlineRawBytes: 6,
        maximumResultRawBytes: 8,
        maximumAggregateSpoolRawBytes: 8,
      }),
    });
    const first = await store.create("first");
    await first.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("123456") });
    await first.finish(0);
    const second = await store.create("second");

    await expect(
      second.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("789") }),
    ).rejects.toMatchObject({ name: "CompletionSpoolCapacityError" });
    expect(await store.open("first")).toBe(first);
    expect(await store.open("second")).toBeUndefined();
    expect(store.usage()).toEqual({ rawBytes: 6, completionCount: 1 });
  });

  it("accepts exactly 256 MiB and deletes the partial spool one byte over", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-exact-capacity-"));
    roots.push(directory);
    const store = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      policy: outputPolicy(),
    });
    const spool = await store.create("request-a");
    const fullChunk = Buffer.alloc(outputPolicy().maximumChunkRawBytes);
    const fullChunkCount =
      outputPolicy().maximumResultRawBytes / outputPolicy().maximumChunkRawBytes;
    for (let sequence = 0; sequence < fullChunkCount; sequence += 1) {
      await spool.append({ sequence, stream: "stdout", bytes: fullChunk });
    }

    expect(store.usage().rawBytes).toBe(outputPolicy().maximumResultRawBytes);
    await expect(
      spool.append({ sequence: fullChunkCount, stream: "stdout", bytes: Buffer.from("x") }),
    ).rejects.toMatchObject({ name: "CompletionSpoolCapacityError" });
    expect(await store.open("request-a")).toBeUndefined();
    expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    expect(await readdir(join(directory, "instance-a"))).toEqual([]);
  }, 30_000);

  it("cleans only the confirmed dead instance and rejects unsafe existing storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-cleanup-"));
    roots.push(directory);
    const firstStore = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      policy: outputPolicy(),
    });
    const secondStore = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-b",
      policy: outputPolicy(),
    });
    const first = await firstStore.create("first");
    await first.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("a") });
    await first.finish(0);
    const second = await secondStore.create("second");
    await second.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("b") });
    await second.finish(0);

    await firstStore.cleanupConfirmedDeadInstance("instance-a");
    expect(await firstStore.open("first")).toBeUndefined();
    expect(await secondStore.open("second")).toBe(second);

    const blocked = join(directory, "blocked");
    await writeFile(blocked, "not a directory");
    await chmod(blocked, 0o600);
    const blockedStore = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory: blocked,
      workspaceKey: "workspace-a",
      instanceId: "instance-c",
      policy: outputPolicy({ maximumChunkRawBytes: 1, inlineRawBytes: 1 }),
    });
    const blockedSpool = await blockedStore.create("blocked-request");
    await blockedSpool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("x") });
    await expect(
      blockedSpool.append({ sequence: 1, stream: "stdout", bytes: Buffer.from("x") }),
    ).rejects.toBeInstanceOf(Error);
    expect(blockedStore.usage()).toEqual({ rawBytes: 0, completionCount: 0 });

    if (process.platform !== "win32") {
      const external = join(directory, "external");
      await mkdir(external);
      await symlink(external, join(directory, "instance-link"));
      const linkedStore = new completionSpoolModule.DaemonCompletionSpoolStore({
        directory,
        workspaceKey: "workspace-a",
        instanceId: "instance-link",
        policy: outputPolicy({ maximumChunkRawBytes: 1, inlineRawBytes: 1 }),
      });
      const linkedSpool = await linkedStore.create("linked-request");
      await linkedSpool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("x") });
      await expect(
        linkedSpool.append({ sequence: 1, stream: "stdout", bytes: Buffer.from("x") }),
      ).rejects.toThrow("Completion spool directory is unsafe");
      expect(await readdir(external)).toEqual([]);
      expect(linkedStore.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    }
  });

  it.each(["sync", "close"] as const)(
    "releases ownership and retries physical cleanup after a %s failure",
    async (operation) => {
      const directory = await mkdtemp(join(tmpdir(), "symnav-completion-finish-failure-"));
      roots.push(directory);
      const storage = new FailingCompletionSpoolStorage(operation);
      const store = new completionSpoolModule.DaemonCompletionSpoolStore({
        directory,
        workspaceKey: "workspace-a",
        instanceId: "instance-a",
        policy: outputPolicy({ maximumChunkRawBytes: 6, inlineRawBytes: 6 }),
        storage,
      });
      const spool = await store.create("request-a");
      await spool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("stored") });
      await spool.append({ sequence: 1, stream: "stdout", bytes: Buffer.from("x") });

      await expect(spool.finish(0)).rejects.toThrow(`${operation} failed`);
      expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
      expect(await store.open("request-a")).toBeUndefined();

      await expect(spool.dispose()).resolves.toBeUndefined();
      expect(await readdir(join(directory, "instance-a"))).toEqual([]);
      expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    },
  );

  it("releases acknowledged quota and retries failed unlink during instance cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-unlink-failure-"));
    roots.push(directory);
    const store = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      policy: outputPolicy({ maximumChunkRawBytes: 6, inlineRawBytes: 6 }),
      storage: new FailingCompletionSpoolStorage("unlink"),
    });
    const spool = await store.create("request-a");
    await spool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("stored") });
    await spool.append({ sequence: 1, stream: "stdout", bytes: Buffer.from("x") });
    await spool.finish(0);

    await expect(spool.acknowledge()).rejects.toThrow("unlink failed");
    expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    expect(await store.open("request-a")).toBeUndefined();
    expect(await readdir(join(directory, "instance-a"))).toHaveLength(1);

    await expect(store.cleanupInstance("instance-a")).resolves.toBeUndefined();
    await expect(access(join(directory, "instance-a"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
  });
});

function outputPolicy(
  overrides: Partial<ReturnType<typeof defaultOutputPolicy>> = {},
): ReturnType<typeof defaultOutputPolicy> {
  return DaemonPolicyTestFactory.withOverrides(
    DaemonPolicy.fromSystemMemory({ totalBytes: 1024 ** 3 }),
    { output: overrides },
  ).values.output;
}

function defaultOutputPolicy() {
  return DaemonPolicy.fromSystemMemory({ totalBytes: 1024 ** 3 }).values.output;
}

class FailingCompletionSpoolStorage extends completionSpoolModule.NodeCompletionSpoolStorage {
  private failed = false;

  constructor(private readonly operation: "sync" | "close" | "unlink") {
    super();
  }

  override async createFile(path: string): Promise<completionSpoolModule.CompletionSpoolFile> {
    const file = await super.createFile(path);
    return {
      write: (bytes) => file.write(bytes),
      sync: async () => {
        if (this.fail("sync")) throw new Error("sync failed");
        await file.sync();
      },
      close: async () => {
        if (this.fail("close")) throw new Error("close failed");
        await file.close();
      },
    };
  }

  override async unlink(path: string): Promise<void> {
    if (this.fail("unlink")) throw new Error("unlink failed");
    await super.unlink(path);
  }

  private fail(operation: "sync" | "close" | "unlink"): boolean {
    if (this.failed || this.operation !== operation) return false;
    this.failed = true;
    return true;
  }
}
