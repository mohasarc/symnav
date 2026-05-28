import { describe, expect, it } from "vitest";

import type { SymbolIdentity } from "@symnav/core";

import { formatHeadLine, formatIdentityPath, formatRange, treeGlyphsFor } from "./render-format.js";

describe("render-format", () => {
  describe("formatRange", () => {
    it("renders a single-line range as `N`", () => {
      expect(formatRange({ startLine: 8, endLine: 8 })).toBe("8");
    });

    it("renders a multi-line range as `N-M`", () => {
      expect(formatRange({ startLine: 12, endLine: 96 })).toBe("12-96");
    });
  });

  describe("formatHeadLine", () => {
    it("composes prefix + range + path with `: ` and a trailing newline", () => {
      expect(formatHeadLine("", { startLine: 4, endLine: 4 }, "greet")).toBe("4: greet\n");
    });

    it("preserves the caller-supplied prefix verbatim", () => {
      expect(formatHeadLine("├── ", { startLine: 2, endLine: 4 }, "C::m")).toBe("├── 2-4: C::m\n");
    });
  });

  describe("formatIdentityPath", () => {
    it("joins segment names with `::`", () => {
      const identity: SymbolIdentity = {
        file: "src/file.ts",
        segments: [{ name: "Router" }, { name: "post" }],
      };
      expect(formatIdentityPath(identity)).toBe("Router::post");
    });

    it("appends `#N` to segments that carry a disambiguator", () => {
      const identity: SymbolIdentity = {
        file: "src/file.ts",
        segments: [{ name: "Router" }, { name: "post", disambiguator: 2 }],
      };
      expect(formatIdentityPath(identity)).toBe("Router::post#2");
    });
  });

  describe("treeGlyphsFor", () => {
    it("returns branch + vertical continuation for a non-last child", () => {
      expect(treeGlyphsFor(false)).toEqual({ branchGlyph: "├── ", continuationGlyph: "│   " });
    });

    it("returns last + space continuation for the last child", () => {
      expect(treeGlyphsFor(true)).toEqual({ branchGlyph: "└── ", continuationGlyph: "    " });
    });
  });
});
