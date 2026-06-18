import { describe, expect, it } from "vitest";

import type { SymbolReference } from "@symnav/core";

import { PREVIEW_WIDTH, fullPreview, trimPreview } from "./trim-preview.js";

function reference(previewSource: string, matchStart: number, matchEnd: number): SymbolReference {
  return {
    file: "src/example.ts",
    line: 1,
    previewSource,
    matchStart,
    matchEnd,
    kind: "usage",
  };
}

describe("trimPreview", () => {
  it("returns a short line unchanged after whitespace stripping", () => {
    const line = "const receipt = await PaymentProcessor.charge(order)";
    const start = line.indexOf("PaymentProcessor");
    expect(trimPreview(reference(line, start, start + "PaymentProcessor".length))).toBe(line);
  });

  it("strips leading and trailing whitespace while keeping the match intact", () => {
    const body = "const receipt = await PaymentProcessor.charge(order)";
    const line = `    ${body}   `;
    const start = line.indexOf("PaymentProcessor");
    const trimmed = trimPreview(reference(line, start, start + "PaymentProcessor".length));
    expect(trimmed).toBe(body);
    expect(trimmed).toContain("PaymentProcessor");
  });

  it("keeps the head and appends an ellipsis when the match fits the first window", () => {
    const line = `const value = PaymentProcessor.charge(${"x".repeat(100)})`;
    const start = line.indexOf("PaymentProcessor");
    const trimmed = trimPreview(reference(line, start, start + "PaymentProcessor".length));
    expect(trimmed).toBe(`${line.slice(0, PREVIEW_WIDTH - 1)}…`);
    expect(trimmed).toHaveLength(PREVIEW_WIDTH);
    expect(trimmed).toContain("PaymentProcessor");
  });

  it("slides the window with a leading ellipsis when the match sits past the first window", () => {
    const line = `${"x".repeat(120)}PaymentProcessor.charge(order)`;
    const start = line.indexOf("PaymentProcessor");
    const trimmed = trimPreview(reference(line, start, start + "PaymentProcessor".length));
    expect(trimmed).toBe(`…${line.slice(line.length - (PREVIEW_WIDTH - 1))}`);
    expect(trimmed).toHaveLength(PREVIEW_WIDTH);
    expect(trimmed).toContain("PaymentProcessor.charge(order)");
  });

  it("adds ellipses on both ends when the line overflows both sides of the match", () => {
    const line = `${"a".repeat(100)}PaymentProcessor${"b".repeat(100)}`;
    const start = line.indexOf("PaymentProcessor");
    const trimmed = trimPreview(reference(line, start, start + "PaymentProcessor".length));
    expect(trimmed).toBe(`…${line.slice(start, start + PREVIEW_WIDTH - 2)}…`);
    expect(trimmed).toHaveLength(PREVIEW_WIDTH);
    expect(trimmed).toContain("PaymentProcessor");
  });

  it("starts at the match and truncates with a trailing ellipsis when the match exceeds the budget", () => {
    const match = "x".repeat(120);
    const line = `call(${match})`;
    const start = line.indexOf(match);
    const trimmed = trimPreview(reference(line, start, start + match.length));
    expect(trimmed).toBe(`…${line.slice(start, start + PREVIEW_WIDTH - 2)}…`);
    expect(trimmed).toHaveLength(PREVIEW_WIDTH);
  });
});

describe("fullPreview", () => {
  it("returns the source line verbatim", () => {
    const line = `    const receipt = await PaymentProcessor.charge(${"x".repeat(100)})`;
    const start = line.indexOf("PaymentProcessor");
    expect(fullPreview(reference(line, start, start + "PaymentProcessor".length))).toBe(line);
  });
});
