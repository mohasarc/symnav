import { describe, expect, it } from "vitest";

import { noSupportedFilesFixtureRoot, runResolve } from "./run-resolve.js";

describe("symnav resolve e2e (no supported files)", () => {
  it.each([
    { label: "exact", args: ["resolve", "Anything"] },
    { label: "fuzzy", args: ["resolve", "--fuzzy", "Anything"] },
    { label: "regex", args: ["resolve", "--regex", "^Any.*"] },
  ])("errors in $label mode when the workspace has no supported files", ({ args }) => {
    const r = runResolve(args, noSupportedFilesFixtureRoot);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Cannot answer: workspace contains no files supported by any language backend.\n",
    );
    expect(r.status).toBe(1);
  });
});
