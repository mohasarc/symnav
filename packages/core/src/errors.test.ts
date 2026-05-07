import { describe, expect, it } from "vitest";
import {
  BackendError,
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "./errors.js";

describe("BackendError hierarchy", () => {
  it("FileNotFoundError is an instance of BackendError and Error", () => {
    const err = new FileNotFoundError("foo.ts");
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
    expect(err.displayedPath).toBe("foo.ts");
  });

  it("OutsideWorkspaceError carries displayedPath and workspaceRoot", () => {
    const err = new OutsideWorkspaceError("../foo.ts", "/repo");
    expect(err).toBeInstanceOf(BackendError);
    expect(err.displayedPath).toBe("../foo.ts");
    expect(err.workspaceRoot).toBe("/repo");
  });

  it("IgnoredFileError carries displayedPath", () => {
    const err = new IgnoredFileError("dist/x.js");
    expect(err).toBeInstanceOf(BackendError);
    expect(err.displayedPath).toBe("dist/x.js");
  });

  it("UnsupportedFileError carries displayedPath and extension", () => {
    const err = new UnsupportedFileError("foo.json", ".json");
    expect(err).toBeInstanceOf(BackendError);
    expect(err.displayedPath).toBe("foo.json");
    expect(err.extension).toBe(".json");
  });
});
