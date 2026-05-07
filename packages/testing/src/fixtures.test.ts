import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath } from "./fixtures.js";

describe("fixturePath", () => {
  it("resolves trivial-project to an absolute path of an existing directory", () => {
    const path = fixturePath("trivial-project");
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it("trivial-project directory contains package.json, tsconfig.json, and src/index.ts", () => {
    const path = fixturePath("trivial-project");
    expect(existsSync(join(path, "package.json"))).toBe(true);
    expect(existsSync(join(path, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(path, "src", "index.ts"))).toBe(true);
  });

  it("throws an error naming the missing fixture for an unknown name", () => {
    expect(() => fixturePath("does-not-exist")).toThrowError(/does-not-exist/);
  });
});
