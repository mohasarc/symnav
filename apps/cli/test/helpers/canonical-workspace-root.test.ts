import { describe, expect, it } from "vitest";
import { canonicalWorkspaceRoot } from "./canonical-workspace-root.js";

describe("canonicalWorkspaceRoot", () => {
  it("preserves POSIX roots", () => {
    expect(canonicalWorkspaceRoot("/tmp/workspace")).toBe("/tmp/workspace");
  });

  it("normalizes Windows roots to the workspace contract", () => {
    expect(canonicalWorkspaceRoot("C:\\tmp\\workspace")).toBe("C:/tmp/workspace");
  });
});
