import { describe, expect, it } from "vitest";
import { TS_EXTENSIONS, TypeScriptBackend } from "./index.js";

describe("@symnav/backend-typescript public surface", () => {
  it("exports TypeScriptBackend and TS_EXTENSIONS", () => {
    expect(typeof TypeScriptBackend).toBe("function");
    expect(TS_EXTENSIONS).toContain(".ts");
  });
});
