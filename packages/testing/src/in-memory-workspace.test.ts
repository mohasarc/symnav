import { describe, expect, it } from "vitest";
import { NotInWorkspaceError } from "@symnav/core";
import { inMemoryWorkspace } from "./in-memory-workspace.js";

describe("inMemoryWorkspace", () => {
  it("rejects with NotInWorkspaceError when no .git entry is present", async () => {
    await expect(
      inMemoryWorkspace({
        files: {
          "/elsewhere/x.ts": "export {};\n",
        },
        startDir: "/elsewhere",
      }),
    ).rejects.toBeInstanceOf(NotInWorkspaceError);
  });
});
