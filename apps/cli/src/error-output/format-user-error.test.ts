import { describe, expect, it } from "vitest";
import {
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";
import { formatUserError } from "./format-user-error.js";

describe("formatUserError for BackendError subclasses", () => {
  it("formats FileNotFoundError with the input path", () => {
    expect(formatUserError(new FileNotFoundError(), { inputPath: "src/missing.ts" })).toBe(
      "Cannot answer: file not found: src/missing.ts.",
    );
  });

  it("formats IgnoredFileError with the input path", () => {
    expect(formatUserError(new IgnoredFileError(), { inputPath: "build/a.ts" })).toBe(
      "Cannot answer: build/a.ts is ignored by .gitignore.",
    );
  });

  it("formats OutsideWorkspaceError with the input path and workspace root", () => {
    expect(
      formatUserError(new OutsideWorkspaceError(), {
        inputPath: "/other/src/a.ts",
        workspaceRoot: "/repo",
      }),
    ).toBe("Cannot answer: /other/src/a.ts is outside the workspace rooted at /repo.");
  });

  it("formats UnsupportedFileError with the extension derived from inputPath", () => {
    expect(formatUserError(new UnsupportedFileError(), { inputPath: "README.md" })).toBe(
      "Cannot answer: cannot read .md files (README.md).",
    );
  });
});

describe("formatUserError for NotInWorkspaceError", () => {
  it("formats NotInWorkspaceError citing cwd", () => {
    expect(formatUserError(new NotInWorkspaceError("/some/dir"), { cwd: "/some/dir" })).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /some/dir).",
    );
  });
});
