import { describe, expect, it } from "vitest";
import { NotInWorkspaceError } from "@symnav/core";
import { inMemoryWorkspace } from "./in-memory-workspace.js";

describe("inMemoryWorkspace", () => {
  it("rejects with NotInWorkspaceError when files contain no .git entry", async () => {
    await expect(
      inMemoryWorkspace({
        files: { "/somewhere/x.ts": "" },
        startDir: "/somewhere",
      }),
    ).rejects.toBeInstanceOf(NotInWorkspaceError);
  });
});
