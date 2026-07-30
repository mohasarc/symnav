import { describe, expect, it } from "vitest";

import { HEADER_CAP_LINES, HEADER_ELLIPSIS, capHeaderLines } from "./header-cap.js";

describe("capHeaderLines", () => {
  it("returns a list at or under the cap unchanged", () => {
    const atCap = Array.from({ length: HEADER_CAP_LINES }, (_, i) => `line ${i}`);
    expect(capHeaderLines(atCap)).toEqual(atCap);

    const underCap = atCap.slice(0, HEADER_CAP_LINES - 1);
    expect(capHeaderLines(underCap)).toEqual(underCap);
  });

  it("truncates a longer list to the cap with a final elision marker", () => {
    const oversized = Array.from({ length: HEADER_CAP_LINES + 5 }, (_, i) => `line ${i}`);
    const capped = capHeaderLines(oversized);

    expect(capped).toHaveLength(HEADER_CAP_LINES);
    expect(capped[capped.length - 1]).toBe(HEADER_ELLIPSIS);
    expect(capped.slice(0, HEADER_CAP_LINES - 1)).toEqual(oversized.slice(0, HEADER_CAP_LINES - 1));
  });
});
