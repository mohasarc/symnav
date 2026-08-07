import { describe, expect, it } from "vitest";

import { splitHeaderLines } from "./split-header-lines.js";

describe("splitHeaderLines", () => {
  it("returns a one-element array for a single-line string", () => {
    expect(splitHeaderLines("function greet(): void")).toEqual(["function greet(): void"]);
  });

  it("returns one element per line for a newline-joined string", () => {
    const raw = ["function configure(", "  host: string,", "): void"].join("\n");
    expect(splitHeaderLines(raw)).toEqual(["function configure(", "  host: string,", "): void"]);
  });

  it("produces no element containing a newline", () => {
    const lines = splitHeaderLines(["a", "b", "c"].join("\n"));
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
  });
});
