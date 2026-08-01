import { describe, expect, it } from "vitest";

import { InvalidSymbolIdError, formatSymbolIdentity } from "./canonical-identity.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import { SymbolTargetGrammar } from "../target/symbol-target-pattern.js";

describe("formatSymbolIdentity", () => {
  it("formats an identity with no disambiguators", () => {
    const identity: SymbolIdentity = {
      file: "src/foo.ts",
      segments: [{ name: "Bar" }, { name: "baz" }],
    };
    expect(formatSymbolIdentity(identity)).toBe("src/foo.ts::Bar::baz");
  });

  it("formats a leaf disambiguator", () => {
    const identity: SymbolIdentity = {
      file: "src/foo.ts",
      segments: [{ name: "Bar" }, { name: "baz", disambiguator: 2 }],
    };
    expect(formatSymbolIdentity(identity)).toBe("src/foo.ts::Bar::baz#2");
  });

  it("formats an ancestor disambiguator", () => {
    const identity: SymbolIdentity = {
      file: "src/foo.ts",
      segments: [{ name: "Bar", disambiguator: 1 }, { name: "baz" }],
    };
    expect(formatSymbolIdentity(identity)).toBe("src/foo.ts::Bar#1::baz");
  });

  it("formats a single-segment identity", () => {
    const identity: SymbolIdentity = {
      file: "src/foo.ts",
      segments: [{ name: "topLevel" }],
    };
    expect(formatSymbolIdentity(identity)).toBe("src/foo.ts::topLevel");
  });
});

describe("canonical-identity codec round-trip", () => {
  const valid = [
    "src/foo.ts::Bar::baz",
    "src/foo.ts::Bar::baz#2",
    "src/foo.ts::Bar#1::baz",
    "src/foo.ts::topLevel",
    "src/deep/nested/path.ts::A#3::B::C#7",
  ];

  for (const id of valid) {
    it(`round-trips ${id}`, () => {
      const pattern = SymbolTargetGrammar.parse(id);
      expect(
        formatSymbolIdentity({ file: pattern.fileSuffix!, segments: pattern.segmentSuffix }),
      ).toBe(id);
    });
  }
});

describe("private field segment names", () => {
  it("round-trips private field names with and without a disambiguator", () => {
    for (const id of ["src/foo.ts::C::#secret", "src/foo.ts::C::#secret#2"]) {
      const pattern = SymbolTargetGrammar.parse(id);
      expect(
        formatSymbolIdentity({ file: pattern.fileSuffix!, segments: pattern.segmentSuffix }),
      ).toBe(id);
    }
  });
});

describe("formatSymbolIdentity file-portion boundary", () => {
  it("rejects a file portion containing the `::` separator", () => {
    expect(() =>
      formatSymbolIdentity({ file: "src/a::b.ts", segments: [{ name: "Foo" }] }),
    ).toThrow(InvalidSymbolIdError);
  });

  it("permits a single colon in the file portion and round-trips it", () => {
    const id = formatSymbolIdentity({ file: "C:/proj/a.ts", segments: [{ name: "Foo" }] });
    const pattern = SymbolTargetGrammar.parse(id);
    expect(pattern.fileSuffix).toBe("C:/proj/a.ts");
    expect(pattern.segmentSuffix).toEqual([{ name: "Foo" }]);
  });
});

describe("InvalidSymbolIdError reasons", () => {
  it("names a file portion containing the `::` separator", () => {
    try {
      formatSymbolIdentity({ file: "a::b.ts", segments: [{ name: "Foo" }] });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSymbolIdError);
      expect((err as InvalidSymbolIdError).reason).toContain('file portion must not contain "::"');
    }
  });
});
