import { describe, expect, it } from "vitest";
import { renderOverviewJson, renderOverviewText } from "./index.js";

describe("@symnav/renderer entry", () => {
  it("re-exports renderOverviewText and renderOverviewJson", () => {
    expect(typeof renderOverviewText).toBe("function");
    expect(typeof renderOverviewJson).toBe("function");
  });
});
