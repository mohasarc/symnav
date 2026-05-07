import { describe, expect, it } from "vitest";
import * as mod from "./index";

describe("symnav", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
