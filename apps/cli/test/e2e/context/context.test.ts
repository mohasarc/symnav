import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../overview/ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("context-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;
const computeId = "src/math/calculator.ts::compute";

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runContext(args: readonly string[], env?: NodeJS.ProcessEnv) {
  return runSymnavBinary(["context", ...args], { cwd: fixtureRoot, ...(env && { env }) });
}

interface JsonEdge {
  symbol: { identity: { file: string; segments: readonly { name: string }[] } };
  sites: readonly { line: number }[];
  confidence: string;
}

interface JsonContextResult {
  identity: { file: string; segments: readonly { name: string }[] };
  callers: { edges: readonly JsonEdge[]; overflow: number };
  callees: { edges: readonly JsonEdge[]; overflow: number };
  references: { total: number; kindCounts: Record<string, number> };
  history: readonly { shortSha: string; isoDate: string; author: string; subject: string }[];
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav context e2e (default output)", () => {
  it("renders all five sections for a symbol with callers, callees, refs, and history", async () => {
    const r = runContext([computeId]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("compute.expected.txt"));
  });

  it("groups repeated call sites from one caller as a single [call ×N] edge", () => {
    const r = runContext([computeId]);
    expect(r.stdout).toContain("runTwice  [call ×2]");
    expect(r.stdout).toContain("runOnce  [call]");
  });

  it("tags the definition as the implementation", () => {
    const r = runContext([computeId]);
    expect(r.stdout).toContain("[implementation]");
  });
});

describe("symnav context e2e (overflow)", () => {
  it("caps callers and points overflow at graph --incoming", () => {
    const r = runContext(["src/popular/popular.ts::popular"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("more callers");
    expect(r.stdout).toContain("symnav graph src/popular/popular.ts::popular --incoming");
  });
});

describe("symnav context e2e (empty sections)", () => {
  it("renders (none) for an isolated leaf symbol with no callers or callees", () => {
    const r = runContext(["src/leaf/leaf.ts::isolated"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Callers\n(none)");
    expect(r.stdout).toContain("Callees\n(none)");
  });

  it("renders (none) history for a symbol in an uncommitted file", () => {
    const r = runContext(["src/fresh/draft.ts::draftHandler"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Recent History\n(none)");
  });
});

describe("symnav context e2e (JSON output)", () => {
  it("emits parseable JSON with certain edges only and every section present", () => {
    const r = runContext([computeId, "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as JsonContextResult;
    expect(parsed.identity).toEqual({
      file: "src/math/calculator.ts",
      segments: [{ name: "compute" }],
    });
    expect(parsed.callees.edges.map((edge) => edge.symbol.identity.segments[0]!.name)).toEqual([
      "add",
      "multiply",
    ]);
    expect(parsed.callers.edges.map((edge) => edge.symbol.identity.segments[0]!.name)).toEqual([
      "runOnce",
      "runTwice",
    ]);
    expect(parsed.callers.edges.every((edge) => edge.confidence === "certain")).toBe(true);
    expect(parsed.callees.edges.every((edge) => edge.confidence === "certain")).toBe(true);
    expect(parsed.references.total).toBe(4);
    expect(parsed.references.kindCounts).toMatchObject({ usage: 3, import: 1 });
    expect(parsed.history).toHaveLength(4);
    expect(parsed.history[0]).toMatchObject({
      isoDate: "2023-04-25",
      author: "Calc Bot",
      subject: "name the scaled value",
    });
  });
});

describe("symnav context e2e (errors)", () => {
  it("refuses a missing symbol with Cannot answer and exit 1", () => {
    const r = runContext(["src/math/calculator.ts::nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "Cannot answer: no symbol src/math/calculator.ts::nonexistent found",
    );
  });

  it("refuses an ambiguous multi-implementation symbol with candidate ids", () => {
    const r = runContext(["src/contract/shape.ts::Shape::area"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cannot answer:");
    expect(r.stderr).toContain("matches multiple implementations");
    expect(r.stderr).toContain("src/contract/circle.ts::Circle::area");
    expect(r.stderr).toContain("src/contract/square.ts::Square::area");
  });
});

describe("symnav context e2e (telemetry)", () => {
  it("appends one shape-only context event when enabled", () => {
    const stateDir = newStateDir();
    const r = runContext([computeId], { SYMNAV_STATE_DIR: stateDir, SYMNAV_TELEMETRY: "1" });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const event = JSON.parse(singleUsageLine(stateDir)) as {
      command: string;
      outcome: string;
      resultCounts?: Record<string, number>;
    };
    expect(event.command).toBe("context");
    expect(event.outcome).toBe("success");
    expect(Object.keys(event.resultCounts ?? {}).sort()).toEqual([
      "callees",
      "callers",
      "history",
      "references",
    ]);
  });

  it("writes nothing and matches output when telemetry is disabled", () => {
    const enabledDir = newStateDir();
    const disabledDir = newStateDir();
    const enabled = runContext([computeId], {
      SYMNAV_STATE_DIR: enabledDir,
      SYMNAV_TELEMETRY: "1",
    });
    const disabled = runContext([computeId], {
      SYMNAV_STATE_DIR: disabledDir,
      SYMNAV_TELEMETRY: "0",
    });

    expect(existsSync(usageLogPath(disabledDir))).toBe(false);
    expect(enabled.status).toBe(disabled.status);
    expect(enabled.stdout).toBe(disabled.stdout);
    expect(enabled.stderr).toBe(disabled.stderr);
  });
});

function newStateDir(): string {
  return join(mkdtempSync(join(tmpdir(), "symnav-context-e2e-")), ".symnav");
}

function usageLogPath(stateDir: string): string {
  return join(stateDir, "usage.jsonl");
}

function singleUsageLine(stateDir: string): string {
  const lines = readFileSync(usageLogPath(stateDir), "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0]!;
}
