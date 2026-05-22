import { describe, expect, it } from "vitest";

import {
  InvalidSymbolIdError,
  formatSymbolIdentity,
  parseSymbolIdentity,
} from "./canonical-identity.js";
import type { SymbolIdentity } from "./symbol-identity.js";

describe("parseSymbolIdentity", () => {
  it("parses a simple `<file>::<segment>::<segment>` id", () => {
    expect(parseSymbolIdentity("src/foo.ts::Bar::baz")).toEqual({
      file: "src/foo.ts",
      segments: [{ name: "Bar" }, { name: "baz" }],
    });
  });

  it("parses a leaf disambiguator `src/foo.ts::Bar::baz#2`", () => {
    expect(parseSymbolIdentity("src/foo.ts::Bar::baz#2")).toEqual({
      file: "src/foo.ts",
      segments: [{ name: "Bar" }, { name: "baz", disambiguator: 2 }],
    });
  });

  it("parses an ancestor disambiguator `src/foo.ts::Bar#1::baz`", () => {
    expect(parseSymbolIdentity("src/foo.ts::Bar#1::baz")).toEqual({
      file: "src/foo.ts",
      segments: [{ name: "Bar", disambiguator: 1 }, { name: "baz" }],
    });
  });

  it("parses a single-segment id `src/foo.ts::topLevel`", () => {
    expect(parseSymbolIdentity("src/foo.ts::topLevel")).toEqual({
      file: "src/foo.ts",
      segments: [{ name: "topLevel" }],
    });
  });

  it("rejects empty input", () => {
    expect(() => parseSymbolIdentity("")).toThrow(InvalidSymbolIdError);
  });

  it("rejects input missing the `::` separator", () => {
    expect(() => parseSymbolIdentity("src/foo.ts")).toThrow(InvalidSymbolIdError);
  });

  it("rejects empty interior segments (`a::::b`)", () => {
    expect(() => parseSymbolIdentity("a::::b")).toThrow(InvalidSymbolIdError);
  });

  it("rejects trailing empty segment (`a::b::`)", () => {
    expect(() => parseSymbolIdentity("a::b::")).toThrow(InvalidSymbolIdError);
  });

  it("rejects zero disambiguator (`a::b#0`)", () => {
    expect(() => parseSymbolIdentity("a::b#0")).toThrow(InvalidSymbolIdError);
  });

  it("rejects negative disambiguator (`a::b#-1`)", () => {
    expect(() => parseSymbolIdentity("a::b#-1")).toThrow(InvalidSymbolIdError);
  });

  it("rejects non-numeric disambiguator (`a::b#abc`)", () => {
    expect(() => parseSymbolIdentity("a::b#abc")).toThrow(InvalidSymbolIdError);
  });

  it("attaches the raw input to the thrown error for surfaceable diagnostics", () => {
    try {
      parseSymbolIdentity("a::b#abc");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSymbolIdError);
      expect((err as InvalidSymbolIdError).reason).toContain("a::b#abc");
    }
  });
});

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
      expect(formatSymbolIdentity(parseSymbolIdentity(id))).toBe(id);
    });
  }
});

describe("private field segment names", () => {
  it("parses a leading-`#` name as a plain name, not a disambiguator", () => {
    expect(parseSymbolIdentity("src/foo.ts::C::#secret")).toEqual({
      file: "src/foo.ts",
      segments: [{ name: "C" }, { name: "#secret" }],
    });
  });

  it("parses a private field carrying a trailing disambiguator", () => {
    expect(parseSymbolIdentity("src/foo.ts::C::#secret#2")).toEqual({
      file: "src/foo.ts",
      segments: [{ name: "C" }, { name: "#secret", disambiguator: 2 }],
    });
  });

  it("round-trips private field names with and without a disambiguator", () => {
    for (const id of ["src/foo.ts::C::#secret", "src/foo.ts::C::#secret#2"]) {
      expect(formatSymbolIdentity(parseSymbolIdentity(id))).toBe(id);
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
    expect(parseSymbolIdentity(id)).toEqual({
      file: "C:/proj/a.ts",
      segments: [{ name: "Foo" }],
    });
  });
});

describe("InvalidSymbolIdError reasons", () => {
  function reasonOf(thrower: () => unknown): string {
    try {
      thrower();
    } catch (err) {
      if (err instanceof InvalidSymbolIdError) return err.reason;
      throw err;
    }
    throw new Error("expected InvalidSymbolIdError to be thrown");
  }

  it("names empty input", () => {
    expect(reasonOf(() => parseSymbolIdentity(""))).toContain("empty input");
  });

  it("names a missing `::` separator", () => {
    expect(reasonOf(() => parseSymbolIdentity("src/foo.ts"))).toContain("missing `::` separator");
  });

  it("names an empty file portion", () => {
    expect(reasonOf(() => parseSymbolIdentity("::Foo"))).toContain("empty file portion");
  });

  it("names an empty path segment", () => {
    expect(reasonOf(() => parseSymbolIdentity("a::::b"))).toContain(
      'empty path segment between "::" separators',
    );
  });

  it("names a non-numeric disambiguator and echoes the offending text", () => {
    const reason = reasonOf(() => parseSymbolIdentity("a::b#abc"));
    expect(reason).toContain("disambiguator must be a positive integer");
    expect(reason).toContain('"abc"');
  });

  it("names a file portion containing the `::` separator", () => {
    expect(
      reasonOf(() => formatSymbolIdentity({ file: "a::b.ts", segments: [{ name: "Foo" }] })),
    ).toContain('file portion must not contain "::"');
  });

  it("echoes the raw offending input", () => {
    expect(reasonOf(() => parseSymbolIdentity("a::b#abc"))).toContain("a::b#abc");
  });
});
