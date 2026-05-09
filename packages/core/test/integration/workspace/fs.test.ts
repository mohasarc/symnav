import { describe, expect, it } from "vitest";
import { InMemoryWorkspace } from "../../helpers/in-memory-workspace.js";

describe("Workspace filesystem", () => {
  it("fs.readFile reads files placed in the in-memory map", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/hello.txt": "Hello, world!\n",
      },
      startDir: "/repo",
    });
    await expect(ws.fs.readFile("/repo/hello.txt")).resolves.toBe("Hello, world!\n");
  });
});
