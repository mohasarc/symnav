import { describe, expect, it } from "vitest";

import { splitSignatureLines } from "./split-signature-lines.js";

describe("splitSignatureLines", () => {
  it("returns a one-element array for a single-line string", () => {
    expect(splitSignatureLines("function greet(): void")).toEqual(["function greet(): void"]);
  });

  it("returns one element per line for a newline-joined string", () => {
    const raw = ["function configure(", "  host: string,", "): void"].join("\n");
    expect(splitSignatureLines(raw)).toEqual([
      "function configure(",
      "  host: string,",
      "): void",
    ]);
  });

  it("produces no element containing a newline", () => {
    const lines = splitSignatureLines(["a", "b", "c"].join("\n"));
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
  });
});
