import { describe, expect, it } from "vitest";
import { relPathFromRoot } from "./rel-from-root.js";

describe("relPathFromRoot", () => {
  it("returns the empty string for the root itself", () => {
    expect(relPathFromRoot("/repo", "/repo")).toBe("");
  });

  it("strips the root prefix from a descendant path", () => {
    expect(relPathFromRoot("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("handles a filesystem root of '/' without dropping a leading character", () => {
    expect(relPathFromRoot("/src/a.ts", "/")).toBe("src/a.ts");
    expect(relPathFromRoot("/", "/")).toBe("");
  });

  it("returns the empty string for a path outside the root", () => {
    expect(relPathFromRoot("/other/a.ts", "/repo")).toBe("");
  });
});
