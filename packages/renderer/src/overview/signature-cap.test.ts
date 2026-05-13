import { describe, expect, it } from "vitest";

import { SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS, capSignature } from "./signature-cap.js";

describe("capSignature", () => {
  it("returns the source unchanged when its length is at or below SIGNATURE_CAP_CHARS", () => {
    const exact = "x".repeat(SIGNATURE_CAP_CHARS);
    expect(capSignature(exact)).toBe(exact);

    const shorter = "x".repeat(SIGNATURE_CAP_CHARS - 1);
    expect(capSignature(shorter)).toBe(shorter);
  });

  it("returns the first SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length chars plus SIGNATURE_ELLIPSIS otherwise", () => {
    const oversized = "x".repeat(SIGNATURE_CAP_CHARS + 50);
    const capped = capSignature(oversized);

    expect(capped.length).toBe(SIGNATURE_CAP_CHARS);
    expect(capped.endsWith(SIGNATURE_ELLIPSIS)).toBe(true);
    expect(capped.slice(0, SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length)).toBe(
      oversized.slice(0, SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length),
    );
  });
});
