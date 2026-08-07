import { describe, expect, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";

const fixtureRunner = new FixtureRunner("resolve-cases");

function expectSuccessfulHelp(args: readonly string[]): string {
  const result = fixtureRunner.run(args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

function expectHelpToContain(args: readonly string[], expectedSurface: readonly string[]): void {
  const stdout = expectSuccessfulHelp(args);
  for (const expected of expectedSurface) {
    expect(stdout).toContain(expected);
  }
}

describe("symnav help e2e", () => {
  it("lists the public navigation commands", () => {
    expectHelpToContain(["--help"], ["overview", "resolve", "def", "refs", "context", "graph"]);
  });

  it("lists overview targeting and output options", () => {
    expectHelpToContain(
      ["overview", "--help"],
      ["--depth <n>", "--at <text>", "--line <n>", "--json"],
    );
  });

  it("lists resolve matching and output options", () => {
    expectHelpToContain(["resolve", "--help"], ["--fuzzy", "--regex", "--json"]);
  });

  it("shows def target input and line narrowing", () => {
    expectHelpToContain(["def", "--help"], ["<target>", "--line <n>"]);
  });

  it("shows refs target input, line narrowing, pagination, and preview options", () => {
    expectHelpToContain(
      ["refs", "--help"],
      ["<target>", "--line <n>", "--page <n>", "--page-size <n>", "--all", "--full-lines"],
    );
  });

  it("shows context target input and line narrowing", () => {
    expectHelpToContain(["context", "--help"], ["<target>", "--line <n>"]);
  });

  it("shows graph target input, line narrowing, direction flags, depth, and pagination", () => {
    expectHelpToContain(
      ["graph", "--help"],
      [
        "<target>",
        "--line <n>",
        "--incoming",
        "--outgoing",
        "--depth <n>",
        "--page <n>",
        "--page-size <n>",
        "--all",
      ],
    );
  });
});
