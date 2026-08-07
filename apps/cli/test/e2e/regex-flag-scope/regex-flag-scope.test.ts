import { describe, expect, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import { symbolCommands } from "../symbol-command.js";

const fixtureRunner = new FixtureRunner("resolve-cases");

describe("regex flag scope", () => {
  it("exposes regex on resolve help", () => {
    const r = fixtureRunner.run(["resolve", "--help"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--regex");
    expect(r.stdout).toContain("match by JavaScript regex instead of exact name");
  });

  it.each(symbolCommands)("does not expose regex on %s help", (command) => {
    const r = fixtureRunner.run([command, "--help"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("--regex");
    expect(r.stdout).not.toContain("regex");
  });
});
