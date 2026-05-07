import { describe, expect, it } from "vitest";
import * as mod from "./index";

describe("@symnav/backend-typescript", () => {
  it("module loads", () => {
    expect(mod).toBeDefined();
  });
});
