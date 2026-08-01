import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("overview-cases");

function runOverview(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav overview e2e (targeting)", () => {
  it("renders collapsed fold interiors by default", () => {
    const r = runOverview(["overview", "targeted-expansion.ts"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-3: describe("setup", () => {');
    expect(r.stdout).toContain('5-11: describe("cursor", () => {');
    expect(r.stdout).toContain("13-18: action");
    expect(r.stdout).toContain("14-17: if (flag) {");
    expect(r.stdout).not.toContain("setupHelper");
    expect(r.stdout).not.toContain("cursorHelper");
    expect(r.stdout).not.toContain("branchValue");
  });

  it("expands a copied fold header target", () => {
    const r = runOverview([
      "overview",
      "targeted-expansion.ts",
      "--at",
      'describe("cursor")',
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('5-11: describe("cursor", () => {');
    expect(r.stdout).toContain("6: cursorHelper");
    expect(r.stdout).toContain('8-10: describe("nested", () => {');
    expect(r.stdout).not.toContain('describe("setup"');
    expect(r.stdout).not.toContain("nestedHelper");
  });

  it("prints target candidates for ambiguous header text", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--at", "describe"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Cannot answer: overview target matches multiple nodes.");
    expect(r.stderr).toContain('1-3: describe("setup", () => {');
    expect(r.stderr).toContain('5-11: describe("cursor", () => {');
    expect(r.stderr).toContain('8-10: describe("nested", () => {');
  });

  it("includes expansion request metadata in JSON output", () => {
    const r = runOverview([
      "overview",
      "targeted-expansion.ts",
      "--at",
      'describe("cursor")',
      "--depth",
      "1",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      readonly file: string;
      readonly request: { readonly depth: number; readonly at: string };
      readonly entries: readonly { readonly header: { readonly lines: readonly string[] } }[];
    };
    expect(parsed.file).toBe("targeted-expansion.ts");
    expect(parsed.request).toEqual({ depth: 1, at: 'describe("cursor")' });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.header.lines).toEqual(['describe("cursor", () => {']);
  });

  it("rejects malformed depth values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "x"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: depth must be a non-negative integer, got NaN.\n",
    );
  });

  it("rejects negative depth values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "-1"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: depth must be a non-negative integer, got -1.\n",
    );
  });

  it("rejects malformed line values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--line", "x"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: line must be a positive integer, got NaN.\n",
    );
  });

  it("rejects non-positive line values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--line", "0"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: line must be a positive integer, got 0.\n",
    );
  });

  it("rejects fractional line values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--line", "1.5"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: line must be a positive integer, got 1.5.\n",
    );
  });
});
