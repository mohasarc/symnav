import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "./node-file-system.js";

describe("NodeFileSystem metadata", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("changes revision when equal-size content replaces a file with restored modification time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-metadata-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "source.ts");
    const fileSystem = new NodeFileSystem();
    const modifiedAt = new Date("2026-01-01T00:00:00.000Z");

    await writeFile(path, "export const value = 1;\n");
    await utimes(path, modifiedAt, modifiedAt);
    const before = await fileSystem.metadata(path);

    await writeFile(path, "export const value = 2;\n");
    await utimes(path, modifiedAt, modifiedAt);
    const after = await fileSystem.metadata(path);

    expect(after.size).toBe(before.size);
    expect(after.modifiedAtMs).toBe(before.modifiedAtMs);
    expect(after.fileIdentity).toBe(before.fileIdentity);
    expect(after.changeToken).not.toBe(before.changeToken);
  });
});
