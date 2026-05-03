import { describe, expect, it } from "vitest";
import * as mod from "./index";

describe("@symnav/testing", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
