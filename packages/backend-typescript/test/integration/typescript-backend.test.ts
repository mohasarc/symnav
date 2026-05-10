import { describe, expect, it } from "vitest";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";
import { InMemoryWorkspace } from "../helpers/in-memory-workspace.js";

async function backendOver(files: Record<string, string>): Promise<TypeScriptBackend> {
  const workspace = await InMemoryWorkspace.create({
    files: { "/repo/.git/HEAD": "ref: refs/heads/main\n", ...files },
    startDir: "/repo",
  });
  return new TypeScriptBackend(workspace);
}

describe("TypeScriptBackend.accepts", () => {
  it("returns true for .ts, .tsx, .mts, .cts, .d.ts; false for .js, .json, .md", async () => {
    const backend = await backendOver({});
    expect(backend.accepts("src/a.ts")).toBe(true);
    expect(backend.accepts("src/a.tsx")).toBe(true);
    expect(backend.accepts("src/a.mts")).toBe(true);
    expect(backend.accepts("src/a.cts")).toBe(true);
    expect(backend.accepts("src/a.d.ts")).toBe(true);
    expect(backend.accepts("src/a.js")).toBe(false);
    expect(backend.accepts("src/a.json")).toBe(false);
    expect(backend.accepts("README.md")).toBe(false);
  });
});
