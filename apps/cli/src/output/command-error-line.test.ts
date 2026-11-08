import { describe, expect, it } from "vitest";
import { CommandErrorLine } from "./command-error-line.js";

describe("CommandErrorLine", () => {
  it("renders the exact error prefix and a trailing newline", () => {
    expect(CommandErrorLine.render("daemon disabled by SYMNAV_DAEMON=0")).toBe(
      "symnav: error: daemon disabled by SYMNAV_DAEMON=0\n",
    );
  });

  it("renders an error by its message and anything else by its string form", () => {
    expect(CommandErrorLine.renderError(new Error("boom"))).toBe("symnav: error: boom\n");
    expect(CommandErrorLine.renderError("boom")).toBe("symnav: error: boom\n");
  });
});
