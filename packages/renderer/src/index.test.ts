import { describe, expect, it } from "vitest";
import * as mod from "./index.js";

describe("@symnav/renderer", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
