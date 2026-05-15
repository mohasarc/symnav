import { describe, expect, it } from "vitest";

import { SIGNATURE_CAP_LINES, SIGNATURE_ELLIPSIS, capSignatureLines } from "./signature-cap.js";

describe("capSignatureLines", () => {
  it("returns a list at or under the cap unchanged", () => {
    const atCap = Array.from({ length: SIGNATURE_CAP_LINES }, (_, i) => `line ${i}`);
    expect(capSignatureLines(atCap)).toEqual(atCap);

    const underCap = atCap.slice(0, SIGNATURE_CAP_LINES - 1);
    expect(capSignatureLines(underCap)).toEqual(underCap);
  });

  it("truncates a longer list to the cap with a final elision marker", () => {
    const oversized = Array.from({ length: SIGNATURE_CAP_LINES + 5 }, (_, i) => `line ${i}`);
    const capped = capSignatureLines(oversized);

    expect(capped).toHaveLength(SIGNATURE_CAP_LINES);
    expect(capped[capped.length - 1]).toBe(SIGNATURE_ELLIPSIS);
    expect(capped.slice(0, SIGNATURE_CAP_LINES - 1)).toEqual(
      oversized.slice(0, SIGNATURE_CAP_LINES - 1),
    );
  });
});
