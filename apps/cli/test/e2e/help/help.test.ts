import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";

const fixtureRunner = new FixtureRunner("resolve-cases");
const snapshotsDir = fileURLToPath(new URL("./__snapshots__/", import.meta.url));

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

describe("symnav help e2e", () => {
  it("lists the public navigation commands", async () => {
    const r = fixtureRunner.run(["--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("root.expected.txt"));
  });

  it("lists overview targeting and output options", async () => {
    const r = fixtureRunner.run(["overview", "--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("overview.expected.txt"));
  });

  it("lists resolve matching and output options", async () => {
    const r = fixtureRunner.run(["resolve", "--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("resolve.expected.txt"));
  });

  it("shows def target input and line narrowing", async () => {
    const r = fixtureRunner.run(["def", "--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("def.expected.txt"));
  });

  it("shows refs target input, line narrowing, pagination, and preview options", async () => {
    const r = fixtureRunner.run(["refs", "--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("refs.expected.txt"));
  });

  it("shows context target input and line narrowing", async () => {
    const r = fixtureRunner.run(["context", "--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("context.expected.txt"));
  });

  it("shows graph target input, line narrowing, direction flags, depth, and pagination", async () => {
    const r = fixtureRunner.run(["graph", "--help"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("graph.expected.txt"));
  });
});
