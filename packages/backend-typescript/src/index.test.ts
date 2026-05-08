import { describe, expect, it } from "vitest";
import { TS_EXTENSIONS, TypeScriptBackend } from "./index.js";

describe("@symnav/backend-typescript entry", () => {
  it("re-exports TypeScriptBackend and TS_EXTENSIONS", () => {
    expect(typeof TypeScriptBackend).toBe("function");
    expect(Array.isArray(TS_EXTENSIONS)).toBe(true);
    expect(TS_EXTENSIONS).toContain(".ts");
  });
});
