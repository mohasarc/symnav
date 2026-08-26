import { access, chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as completionSpoolModule from "./completion-spool.js";

describe("DaemonCompletionSpoolStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("spills threshold-plus-one output securely and acknowledges exact completion cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-spool-"));
    roots.push(directory);
    const store = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
      inlineBytes: 8,
      maximumResultBytes: 64,
      maximumAggregateBytes: 128,
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
      inlineBytes: 1,
      maximumResultBytes: 8,
      maximumAggregateBytes: 8,
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

  it("cleans only the confirmed dead instance and rejects unsafe existing storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-completion-cleanup-"));
    roots.push(directory);
    const firstStore = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-a",
    });
    const secondStore = new completionSpoolModule.DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-a",
      instanceId: "instance-b",
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
      inlineBytes: 0,
    });
    const blockedSpool = await blockedStore.create("blocked-request");
    await expect(
      blockedSpool.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("x") }),
    ).rejects.toBeInstanceOf(Error);
    expect(blockedStore.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
  });
});
