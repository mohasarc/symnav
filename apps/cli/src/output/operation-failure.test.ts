import { describe, expect, it } from "vitest";
import { OperationFailure } from "./operation-failure.js";

describe("OperationFailure", () => {
  it("names the path and code of a system error instead of its raw message", () => {
    const error = Object.assign(new Error("ENOTDIR: not a directory, scandir '/state/daemons'"), {
      code: "ENOTDIR",
      path: "/state/daemons",
    });

    expect(OperationFailure.render("read daemon status", error)).toBe(
      "symnav: error: cannot read daemon status: cannot access /state/daemons (ENOTDIR)\n",
    );
  });

  it("keeps the message of any other error", () => {
    expect(OperationFailure.render("start daemon", new Error("startup failed"))).toBe(
      "symnav: error: cannot start daemon: startup failed\n",
    );
  });
});
