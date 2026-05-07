import { describe, expect, it } from "vitest";
import * as mod from "./index";

describe("@symnav/renderer", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
