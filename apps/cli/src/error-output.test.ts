import { describe, expect, it } from "vitest";
import {
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";
import { formatUserError } from "./error-output.js";

describe("formatUserError", () => {
  it("formats FileNotFoundError as a file-not-found Cannot answer line", () => {
    const line = formatUserError(new FileNotFoundError("missing.ts"));
    expect(line).toBe("Cannot answer: file not found: missing.ts.");
  });

  it("formats OutsideWorkspaceError citing the workspace root", () => {
    const line = formatUserError(new OutsideWorkspaceError("../outside.ts", "/repo"));
    expect(line).toBe("Cannot answer: ../outside.ts is outside the workspace rooted at /repo.");
  });

  it("formats IgnoredFileError matching the spec voice", () => {
    const line = formatUserError(new IgnoredFileError("ignored.ts"));
    expect(line).toBe("Cannot answer: ignored.ts is ignored by .gitignore.");
  });

  it("formats UnsupportedFileError citing the extension", () => {
    const line = formatUserError(new UnsupportedFileError("package.json", ".json"));
    expect(line).toBe("Cannot answer: .json files are not supported.");
  });

  it("formats NotInWorkspaceError citing the startDir", () => {
    const line = formatUserError(new NotInWorkspaceError("/somewhere"));
    expect(line).toBe("Cannot answer: not in a git workspace (no .git ancestor of /somewhere).");
  });

  it("returns null for an arbitrary unknown error", () => {
    expect(formatUserError(new Error("boom"))).toBeNull();
    expect(formatUserError("not even an error")).toBeNull();
    expect(formatUserError(undefined)).toBeNull();
  });
});
