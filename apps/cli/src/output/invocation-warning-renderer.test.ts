import { describe, expect, it } from "vitest";
import { InvocationWarningRenderer } from "./invocation-warning-renderer.js";

describe("InvocationWarningRenderer", () => {
  it("renders the exact warning prefix and a trailing newline", () => {
    expect(new InvocationWarningRenderer({ warnings: true }).render({ message: "detail ✓" })).toBe(
      "symnav: warning: detail ✓\n",
    );
  });

  it("suppresses a typed warning when warnings are disabled", () => {
    expect(
      new InvocationWarningRenderer({ warnings: false }).render({ message: "detail" }),
    ).toBeUndefined();
  });
});
