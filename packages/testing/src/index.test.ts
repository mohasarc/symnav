import { describe, expect, it } from "vitest";
import * as mod from "./index.js";

describe("@symnav/testing", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
