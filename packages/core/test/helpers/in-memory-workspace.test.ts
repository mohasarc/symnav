import { describe, expect, it } from "vitest";
import { NotInWorkspaceError } from "@symnav/core";
import { InMemoryFileSystem, InMemoryWorkspace } from "./in-memory-workspace.js";

describe("InMemoryWorkspace", () => {
  it("rejects with NotInWorkspaceError when no .git entry is present", async () => {
    await expect(
      InMemoryWorkspace.create({
        files: {
          "/elsewhere/x.ts": "export {};\n",
        },
        startDir: "/elsewhere",
      }),
    ).rejects.toBeInstanceOf(NotInWorkspaceError);
  });
});

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
});
