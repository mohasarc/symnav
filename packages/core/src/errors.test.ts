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
    const err = new FileNotFoundError("src/missing.ts");
    expect(err).toBeInstanceOf(FileNotFoundError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("OutsideWorkspaceError is an instance of BackendError and Error", () => {
    const err = new OutsideWorkspaceError("/tmp/other.ts", "/repo");
    expect(err).toBeInstanceOf(OutsideWorkspaceError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("IgnoredFileError is an instance of BackendError and Error", () => {
    const err = new IgnoredFileError("dist/x.js");
    expect(err).toBeInstanceOf(IgnoredFileError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("UnsupportedFileError is an instance of BackendError and Error", () => {
    const err = new UnsupportedFileError("data.json", ".json");
    expect(err).toBeInstanceOf(UnsupportedFileError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("each error subclass exposes the displayed path", () => {
    expect(new FileNotFoundError("src/missing.ts").displayedPath).toBe(
      "src/missing.ts",
    );
    expect(
      new OutsideWorkspaceError("/tmp/other.ts", "/repo").displayedPath,
    ).toBe("/tmp/other.ts");
    expect(new IgnoredFileError("dist/x.js").displayedPath).toBe("dist/x.js");
    expect(new UnsupportedFileError("data.json", ".json").displayedPath).toBe(
      "data.json",
    );
  });

  it("OutsideWorkspaceError carries the workspace root", () => {
    const err = new OutsideWorkspaceError("/tmp/other.ts", "/repo");
    expect(err.workspaceRoot).toBe("/repo");
  });

  it("UnsupportedFileError carries the file extension", () => {
    const err = new UnsupportedFileError("data.json", ".json");
    expect(err.extension).toBe(".json");
  });
});
