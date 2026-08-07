import { describe, expect, it } from "vitest";

import { runOverview } from "./run-overview.js";

describe("symnav overview e2e (minified line guard)", () => {
  it("rejects a shared line target with a self-explaining candidate error", () => {
    const r = runOverview(["overview", "minified-line.ts", "--line", "1"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "Cannot answer: line 1 matches multiple overview nodes; use --at with copied header text.",
    );
    expect(r.stderr).toContain('1: describe("alpha", () => {');
    expect(r.stderr).toContain('1: describe("beta", () => {');
    expect(r.stderr).toContain('1: describe("gamma", () => {');
  });

  it("targets one same-line fold with copied header text", () => {
    const r = runOverview(["overview", "minified-line.ts", "--at", 'describe("beta")']);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      ["Overview: minified-line.ts", '└── 1: describe("beta", () => {', ""].join("\n"),
    );
  });
});
