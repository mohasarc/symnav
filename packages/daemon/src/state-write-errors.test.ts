import { describe, expect, it } from "vitest";
import { DaemonStateWriteErrors } from "./state-write-errors.js";

describe("DaemonStateWriteErrors", () => {
  it("distinguishes a failed writable open from a failed readable open", () => {
    const error = Object.assign(new Error("denied"), {
      syscall: "open",
      path: "/state/target",
      code: "EACCES",
    });
    expect(DaemonStateWriteErrors.from(error)).toBeUndefined();
    expect(
      DaemonStateWriteErrors.from(DaemonStateWriteErrors.failedWrite("/state/target", error)),
    ).toEqual({ path: "/state/target", osCode: "EACCES" });
  });
  it.each(["mkdir", "write", "rename", "unlink", "rmdir", "chmod", "fsync"])(
    "retains the path and OS code for %s",
    (syscall) => {
      const error = Object.assign(new Error("denied"), {
        syscall,
        path: "/state/target",
        code: "EPERM",
      });
      expect(DaemonStateWriteErrors.from(new Error("transport failed", { cause: error }))).toEqual({
        path: "/state/target",
        osCode: "EPERM",
      });
    },
  );

  it.each(["connect", "open", "read", "stat", undefined])(
    "does not mistake %s failure for a required write",
    (syscall) => {
      expect(
        DaemonStateWriteErrors.from(
          Object.assign(new Error("failed"), { syscall, path: "/state/target", code: "EPERM" }),
        ),
      ).toBeUndefined();
    },
  );

  it("validates only structured path/code metadata", () => {
    expect(DaemonStateWriteErrors.isFailure({ path: "/state", osCode: "ENOSPC" })).toBe(true);
    expect(DaemonStateWriteErrors.isFailure({ path: "/state" })).toBe(true);
    expect(DaemonStateWriteErrors.isFailure({ path: "/state", stderr: "opaque" })).toBe(false);
    expect(DaemonStateWriteErrors.isFailure({ path: "/state", osCode: 4 })).toBe(false);
    expect(DaemonStateWriteErrors.isFailure({ path: "" })).toBe(false);
  });
});
