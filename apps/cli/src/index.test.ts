import { describe, expect, it } from "vitest";
import * as mod from "./index.js";

describe("symnav", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
