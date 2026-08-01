import { describe, expect, it } from "vitest";

import {
  HEADER_CAP_LINES,
  HEADER_CAP_LINE_LENGTH,
  HEADER_ELLIPSIS,
  capHeaderLines,
  capHeaderLineLength,
  stripHeaderEllipsis,
} from "./header-cap.js";

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

describe("capHeaderLineLength", () => {
  it("returns a line at or under the length cap unchanged", () => {
    const atCap = "x".repeat(HEADER_CAP_LINE_LENGTH);
    expect(capHeaderLineLength(atCap)).toBe(atCap);
    expect(capHeaderLineLength("short")).toBe("short");
  });

  it("truncates an over-length line to exactly the cap with a final elision marker", () => {
    const oversized = "x".repeat(HEADER_CAP_LINE_LENGTH + 20);
    const capped = capHeaderLineLength(oversized);

    expect(capped).toHaveLength(HEADER_CAP_LINE_LENGTH);
    expect(capped).toBe("x".repeat(HEADER_CAP_LINE_LENGTH - 1) + HEADER_ELLIPSIS);
  });
});

describe("stripHeaderEllipsis", () => {
  it("strips one trailing elision marker", () => {
    expect(stripHeaderEllipsis(`describe("long${HEADER_ELLIPSIS}`)).toBe('describe("long');
  });

  it("returns plain text unchanged", () => {
    expect(stripHeaderEllipsis('describe("plain")')).toBe('describe("plain")');
  });

  it("leaves a mid-string elision marker in place", () => {
    expect(stripHeaderEllipsis(`const helper = () => ${HEADER_ELLIPSIS};`)).toBe(
      `const helper = () => ${HEADER_ELLIPSIS};`,
    );
  });

  it("strips a lone elision marker to the empty string", () => {
    expect(stripHeaderEllipsis(HEADER_ELLIPSIS)).toBe("");
  });
});
