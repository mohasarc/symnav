import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type SymbolIdentity } from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";

function makeBackend(): TypeScriptBackend {
  const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
  return new TypeScriptBackend(fs);
}

describe("TypeScriptBackend.findDefinitions", () => {
  it("throws not implemented", async () => {
    const backend = makeBackend();
    const identity: SymbolIdentity = { file: "src/foo.ts", segments: [{ name: "Foo" }] };
    await expect(backend.findDefinitions([], identity)).rejects.toThrow("not implemented");
  });
});
