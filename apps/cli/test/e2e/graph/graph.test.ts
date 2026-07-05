import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("graph-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;
const hubId = "src/hub.ts::hub";
const chainRootId = "src/chain.ts::chainRoot";
const cycleId = "src/cycle.ts::cycleA";
const dynamicRootId = "src/dynamic.ts::dynamicRoot";
const isolatedId = "src/isolated.ts::isolatedLeaf";

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runGraph(args: readonly string[], env?: NodeJS.ProcessEnv) {
  return runSymnavBinary(["graph", ...args], { cwd: fixtureRoot, ...(env && { env }) });
}

interface JsonGraphResult {
  identity: { file: string; segments: readonly { name: string }[] };
  direction: string;
  incoming?: { totalPathCount: number; paths: readonly unknown[] };
  outgoing?: { totalPathCount: number; paths: readonly unknown[] };
  page: number;
  pageCount: number;
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav graph e2e (default output)", () => {
  it("renders both directions at depth one for a fan-in and fan-out hub", async () => {
    const r = runGraph([hubId]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("hub.expected.txt"));
  });

  it("renders only incoming paths when --incoming is passed", async () => {
    const r = runGraph([hubId, "--incoming"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Direction: incoming");
    expect(r.stdout).not.toContain("Outgoing");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("hub-incoming.expected.txt"));
  });

  it("renders only outgoing paths when --outgoing is passed", async () => {
    const r = runGraph([hubId, "--outgoing"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Direction: outgoing");
    expect(r.stdout).not.toContain("Incoming");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("hub-outgoing.expected.txt"));
  });

  it("renders multi-hop outgoing nesting at depth three", async () => {
    const r = runGraph([chainRootId, "--outgoing", "--depth", "3"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("chain-depth-3.expected.txt"));
  });

  it("truncates deepest paths at depth five without a cycle marker", () => {
    const r = runGraph([chainRootId, "--outgoing", "--depth", "5"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("chainFive");
    expect(r.stdout).not.toContain("chainSix");
    expect(r.stdout).not.toContain("[cycle]");
  });

  it("marks cycles and does not expand past the repeated symbol", async () => {
    const r = runGraph([cycleId, "--outgoing", "--depth", "5"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[cycle]");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("cycle.expected.txt"));
  });

  it("keeps possible dynamic edges and expands certain edges beyond them", async () => {
    const r = runGraph([dynamicRootId, "--outgoing", "--depth", "2"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[possible: dynamic dispatch: exact callee not statically resolvable]");
    expect(r.stdout).toContain("alphaLeaf  [callee]");
    expect(r.stdout).toContain("betaLeaf  [callee]");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("dynamic.expected.txt"));
  });

  it("renders root-only trees for an isolated leaf", async () => {
    const r = runGraph([isolatedId]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("isolated.expected.txt"));
  });
});

describe("symnav graph e2e (errors)", () => {
  it("refuses depth beyond the maximum with the graph-specific message", () => {
    const r = runGraph([hubId, "--depth", "12"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "Cannot run graph with depth 12.",
        "Maximum supported depth is 5.",
        "",
        "To continue exploration:",
        "1. Run with depth 5.",
        "2. Pick a leaf symbol from the output.",
        "3. Run graph again from that symbol.",
        "",
      ].join("\n"),
    );
  });

  it.each(["0", "x"])("rejects malformed depth %s as a user error", (depth) => {
    const r = runGraph([hubId, "--depth", depth]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cannot answer:");
    expect(r.stderr).toContain(`depth must be a positive integer, got ${depth}`);
  });

  it("rejects conflicting direction flags", () => {
    const r = runGraph([hubId, "--incoming", "--outgoing"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cannot answer:");
    expect(r.stderr).toContain("--incoming cannot be combined with --outgoing");
  });

  it("reuses ambiguous target errors", async () => {
    const r = runGraph(["src/contract.ts::GraphShape::render"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    await expect(r.stderr).toMatchFileSnapshot(snapshot("ambiguous.expected.txt"));
  });

  it("reuses unknown symbol errors", async () => {
    const r = runGraph(["src/hub.ts::missing"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    await expect(r.stderr).toMatchFileSnapshot(snapshot("unknown.expected.txt"));
  });
});

describe("symnav graph e2e (pagination)", () => {
  it("slices fan-in and fan-out paths by page with stable output", async () => {
    const first = runGraph([hubId, "--page-size", "2"]);
    const repeat = runGraph([hubId, "--page-size", "2"]);
    const second = runGraph([hubId, "--page", "2", "--page-size", "2"]);

    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(repeat.stdout);
    expect(first.stdout).not.toBe(second.stdout);
    expect(first.stdout).toContain("Page: 1/3");
    expect(second.stdout).toContain("Page: 2/3");
    await expect(first.stdout).toMatchFileSnapshot(snapshot("hub-page-1.expected.txt"));
    await expect(second.stdout).toMatchFileSnapshot(snapshot("hub-page-2.expected.txt"));
  });
});

describe("symnav graph e2e (JSON output)", () => {
  it("emits a parseable result with both directions and path counts", () => {
    const r = runGraph([hubId, "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as JsonGraphResult;
    expect(parsed.identity).toEqual({ file: "src/hub.ts", segments: [{ name: "hub" }] });
    expect(parsed.direction).toBe("both");
    expect(parsed.incoming?.totalPathCount).toBe(3);
    expect(parsed.outgoing?.totalPathCount).toBe(3);
    expect(parsed.incoming?.paths).toHaveLength(3);
    expect(parsed.outgoing?.paths).toHaveLength(3);
    expect(parsed.page).toBe(1);
    expect(parsed.pageCount).toBe(1);
  });
});

describe("symnav graph e2e (telemetry)", () => {
  it("appends one shape-only graph event when enabled", () => {
    const stateDir = newStateDir();
    const r = runGraph([hubId, "--depth", "2", "--incoming"], {
      SYMNAV_STATE_DIR: stateDir,
      SYMNAV_TELEMETRY: "1",
    });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const event = JSON.parse(singleUsageLine(stateDir)) as {
      command: string;
      outcome: string;
      argShape: { flags: readonly string[] };
      resultCounts?: Record<string, number>;
    };
    expect(event.command).toBe("graph");
    expect(event.outcome).toBe("success");
    expect(event.argShape.flags).toEqual(["depth", "incoming"]);
    expect(Object.keys(event.resultCounts ?? {}).sort()).toEqual([
      "incomingPaths",
      "outgoingPaths",
      "pages",
    ]);
  });

  it("writes nothing and matches output when telemetry is disabled", () => {
    const enabledDir = newStateDir();
    const disabledDir = newStateDir();
    const enabled = runGraph([hubId], {
      SYMNAV_STATE_DIR: enabledDir,
      SYMNAV_TELEMETRY: "1",
    });
    const disabled = runGraph([hubId], {
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
  return join(mkdtempSync(join(tmpdir(), "symnav-graph-e2e-")), ".symnav");
}

function usageLogPath(stateDir: string): string {
  return join(stateDir, "usage.jsonl");
}

function singleUsageLine(stateDir: string): string {
  const lines = readFileSync(usageLogPath(stateDir), "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0]!;
}
