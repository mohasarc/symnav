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
    const err = new FileNotFoundError();
    expect(err).toBeInstanceOf(FileNotFoundError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("OutsideWorkspaceError is an instance of BackendError and Error", () => {
    const err = new OutsideWorkspaceError();
    expect(err).toBeInstanceOf(OutsideWorkspaceError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("IgnoredFileError is an instance of BackendError and Error", () => {
    const err = new IgnoredFileError();
    expect(err).toBeInstanceOf(IgnoredFileError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("UnsupportedFileError is an instance of BackendError and Error", () => {
    const err = new UnsupportedFileError();
    expect(err).toBeInstanceOf(UnsupportedFileError);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toBeInstanceOf(Error);
  });

  it("each subclass carries a fixed opaque message token, not a templated user-facing string", () => {
    expect(new FileNotFoundError().message).toBe("file-not-found");
    expect(new IgnoredFileError().message).toBe("ignored-file");
    expect(new OutsideWorkspaceError().message).toBe("outside-workspace");
    expect(new UnsupportedFileError().message).toBe("unsupported-file");
  });
});
