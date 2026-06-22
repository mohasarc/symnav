import { describe, expect, it } from "vitest";
import { classifyArgKind, lengthBucketOf } from "./arg-shape.js";

describe("classifyArgKind", () => {
  it.each([
    ["a/b.ts", "path"],
    ["a\\b.ts", "path"],
    ["C:/repo/file.ts", "path"],
    ["C:\\repo\\file.ts", "path"],
    ["File.ts::Foo", "symbol_id"],
    ["foo", "bare"],
    ["", "empty"],
  ] as const)("classifies %j as %s", (value, expected) => {
    expect(classifyArgKind(value)).toBe(expected);
  });
});

describe("lengthBucketOf", () => {
  it.each([
    ["", "empty"],
    ["a".repeat(20), "short"],
    ["a".repeat(80), "medium"],
    ["a".repeat(81), "long"],
  ] as const)("classifies length %i as %s", (value, expected) => {
    expect(lengthBucketOf(value)).toBe(expected);
  });
});
