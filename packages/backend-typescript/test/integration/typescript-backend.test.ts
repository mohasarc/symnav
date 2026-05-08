import { describe, expect, it } from "vitest";
import { inMemoryWorkspace } from "@symnav/testing";
import { TypeScriptBackend } from "../../src/typescript-backend.js";

describe("TypeScriptBackend.accepts", () => {
  it("returns true for TypeScript file extensions and false for others", async () => {
    const workspace = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo",
    });
    const backend = new TypeScriptBackend(workspace);

    expect(backend.accepts("src/a.ts")).toBe(true);
    expect(backend.accepts("src/a.tsx")).toBe(true);
    expect(backend.accepts("src/a.mts")).toBe(true);
    expect(backend.accepts("src/a.cts")).toBe(true);
    expect(backend.accepts("src/a.d.ts")).toBe(true);
    expect(backend.accepts("src/A.TS")).toBe(true);

    expect(backend.accepts("src/a.js")).toBe(false);
    expect(backend.accepts("package.json")).toBe(false);
    expect(backend.accepts("README.md")).toBe(false);
    expect(backend.accepts("src/a")).toBe(false);
  });
});
