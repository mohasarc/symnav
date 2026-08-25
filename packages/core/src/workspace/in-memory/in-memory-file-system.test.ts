import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "./in-memory-file-system.js";

describe("InMemoryFileSystem", () => {
  const fs = new InMemoryFileSystem({
    "/repo/.git/HEAD": "ref: refs/heads/main\n",
    "/repo/src/x.ts": "export const x = 1;\n",
  });

  it("readFileSync returns file contents for known paths", () => {
    expect(fs.readFileSync("/repo/src/x.ts")).toBe("export const x = 1;\n");
  });

  it("readFileSync throws for unknown paths", () => {
    expect(() => fs.readFileSync("/repo/missing.ts")).toThrow(/ENOENT/);
  });

  it("existsSync returns true for both files and inferred parent directories", () => {
    expect(fs.existsSync("/repo/src/x.ts")).toBe(true);
    expect(fs.existsSync("/repo/src")).toBe(true);
    expect(fs.existsSync("/repo")).toBe(true);
    expect(fs.existsSync("/repo/missing.ts")).toBe(false);
  });

  it("isDirectorySync distinguishes directories from files", () => {
    expect(fs.isDirectorySync("/repo")).toBe(true);
    expect(fs.isDirectorySync("/repo/src")).toBe(true);
    expect(fs.isDirectorySync("/repo/src/x.ts")).toBe(false);
  });

  it("listDirSync returns immediate children of a directory", () => {
    expect(fs.listDirSync("/repo")).toEqual([".git", "src"]);
    expect(fs.listDirSync("/repo/src")).toEqual(["x.ts"]);
  });

  it("readFile resolves to file contents", async () => {
    await expect(fs.readFile("/repo/src/x.ts")).resolves.toBe("export const x = 1;\n");
  });

  it("exists resolves to whether the path is in the map", async () => {
    await expect(fs.exists("/repo/src/x.ts")).resolves.toBe(true);
    await expect(fs.exists("/repo/missing.ts")).resolves.toBe(false);
  });

  it("derives stable content revisions independent of size and modification time", () => {
    const same = new InMemoryFileSystem({ "/repo/source.ts": "export const a = 1;\n" });
    const sameAgain = new InMemoryFileSystem({ "/repo/source.ts": "export const a = 1;\n" });
    const changed = new InMemoryFileSystem({ "/repo/source.ts": "export const b = 1;\n" });

    expect(same.metadataSync("/repo/source.ts").changeToken).toBe(
      sameAgain.metadataSync("/repo/source.ts").changeToken,
    );
    expect(changed.metadataSync("/repo/source.ts")).toMatchObject({
      size: same.metadataSync("/repo/source.ts").size,
      modifiedAtMs: same.metadataSync("/repo/source.ts").modifiedAtMs,
    });
    expect(changed.metadataSync("/repo/source.ts").changeToken).not.toBe(
      same.metadataSync("/repo/source.ts").changeToken,
    );
  });
});
