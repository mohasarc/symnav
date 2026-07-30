import { describe, expect, it } from "vitest";

import { formatEmptyOverview, formatOverviewHeader, formatHeaderLine } from "./overview-format.js";

describe("overview-format", () => {
  describe("formatOverviewHeader", () => {
    it("renders the header on a single line with a trailing newline", () => {
      expect(formatOverviewHeader("src/file.ts")).toBe("Overview: src/file.ts\n");
    });
  });

  describe("formatEmptyOverview", () => {
    it("appends `(no symbols)` directly under the header", () => {
      expect(formatEmptyOverview("src/file.ts")).toBe("Overview: src/file.ts\n(no symbols)\n");
    });
  });

  describe("formatHeaderLine", () => {
    it("composes prefix + line number + text with a single space and a trailing newline", () => {
      expect(formatHeaderLine("", 10, "function configure(")).toBe("10 function configure(\n");
    });

    it("preserves the caller-supplied prefix verbatim", () => {
      expect(formatHeaderLine("│   ", 24, "constructor()")).toBe("│   24 constructor()\n");
    });
  });
});
