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
