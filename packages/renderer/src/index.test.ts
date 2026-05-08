import { describe, expect, it } from "vitest";
import { renderOverviewJson, renderOverviewText } from "./index.js";

describe("@symnav/renderer public surface", () => {
  it("exports renderOverviewText and renderOverviewJson", () => {
    expect(typeof renderOverviewText).toBe("function");
    expect(typeof renderOverviewJson).toBe("function");
  });
});
