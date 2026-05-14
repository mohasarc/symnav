import { describe, expect, it } from "vitest";
import { createWorkspace, InMemoryFileSystem } from "@symnav/core";

describe("Workspace filesystem", () => {
  it("fs.readFile reads files placed in the in-memory map", async () => {
    const ws = await createWorkspace({
      startDir: "/repo",
      fs: new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/hello.txt": "Hello, world!\n",
      }),
    });
    await expect(ws.fs.readFile("/repo/hello.txt")).resolves.toBe("Hello, world!\n");
  });
});
