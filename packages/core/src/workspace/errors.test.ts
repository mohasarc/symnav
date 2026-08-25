import { describe, expect, it } from "vitest";

import { UserFacingError } from "../errors.js";
import {
  DirectoryInputError,
  FileNotFoundError,
  IgnoredFileError,
  NestedWorkspacePathError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
} from "./errors.js";

describe("workspace errors render their reason", () => {
  it("FileNotFoundError cites the input path", () => {
    const err = new FileNotFoundError("foo.ts");
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.reason).toBe("file not found: foo.ts");
  });

  it("IgnoredFileError cites the input path", () => {
    const err = new IgnoredFileError("foo.ts");
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.reason).toBe("foo.ts is ignored by .gitignore");
  });

  it("DirectoryInputError cites the input path", () => {
    const err = new DirectoryInputError("src/rules");
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.reason).toBe("src/rules is a directory; expected a source file");
  });

  it("OutsideWorkspaceError cites the input path and workspace root", () => {
    const err = new OutsideWorkspaceError("foo.ts", "/repo");
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.reason).toBe("foo.ts is outside the workspace rooted at /repo");
  });

  it("NotInWorkspaceError cites the start directory", () => {
    const err = new NotInWorkspaceError("/x");
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.reason).toBe("not in a git workspace (no .git found in or above /x)");
  });

  it("NestedWorkspacePathError identifies both workspace roots and gives selection guidance", () => {
    const err = new NestedWorkspacePathError(
      "vendor/package/src/index.ts",
      "/repo",
      "/repo/vendor/package",
    );
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.inputPath).toBe("vendor/package/src/index.ts");
    expect(err.workspaceRoot).toBe("/repo");
    expect(err.nestedWorkspaceRoot).toBe("/repo/vendor/package");
    expect(err.render()).toBe(
      "Cannot answer: vendor/package/src/index.ts belongs to nested Git workspace rooted at /repo/vendor/package, not selected workspace /repo; run from /repo/vendor/package or use --cwd /repo/vendor/package.\n",
    );
  });
});
