import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("overview-cases");
const overviewArgs = ["overview", "class-with-methods.ts"] as const;

interface UsageEventLine {
  readonly schemaVersion: number;
  readonly command: string;
  readonly outcome: string;
  readonly argShape: {
    readonly kind: string;
    readonly lengthBucket: string;
    readonly flags: readonly string[];
  };
  readonly resultCounts?: Readonly<Record<string, number>>;
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav telemetry e2e", () => {
  it("appends one shape-only usage line when enabled", () => {
    const stateDir = newStateDir();
    const result = runOverview(stateDir, "1");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const line = singleUsageLine(stateDir);
    const event = JSON.parse(line) as UsageEventLine;

    expect(event).toMatchObject({
      schemaVersion: 1,
      command: "overview",
      outcome: "success",
      argShape: {
        kind: "bare",
        lengthBucket: "medium",
        flags: [],
      },
      resultCounts: { symbols: 3 },
    });
    expect(line).not.toContain("class-with-methods.ts");
    expect(line).not.toContain("Greeter");
    expect(line).not.toContain("greet");
    expect(line).not.toContain("shout");
    expect(line).not.toContain(fixtureRoot);
  });

  it("writes nothing when telemetry is disabled", () => {
    const stateDir = newStateDir();
    const result = runOverview(stateDir, "0");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(usageLogPath(stateDir))).toBe(false);
  });

  it("writes nothing when disabled via a word opt-out value", () => {
    const stateDir = newStateDir();
    const result = runOverview(stateDir, "off");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(usageLogPath(stateDir))).toBe(false);
  });

  it("keeps command output identical when telemetry is on or off", () => {
    const enabled = runOverview(newStateDir(), "1");
    const disabled = runOverview(newStateDir(), "0");

    expect(enabled.status).toBe(disabled.status);
    expect(enabled.stdout).toBe(disabled.stdout);
    expect(enabled.stderr).toBe(disabled.stderr);
  });

  it("reports enabled runs through stats json", () => {
    const stateDir = newStateDir();

    runOverview(stateDir, "1");
    runOverview(stateDir, "1");
    runOverview(stateDir, "1");

    const result = runSymnavBinary(["stats", "--json"], {
      cwd: fixtureRoot,
      env: { SYMNAV_STATE_DIR: stateDir },
    });
    const summary = JSON.parse(result.stdout) as { totalEvents: number };

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(summary.totalEvents).toBe(3);
  });
});

function runOverview(stateDir: string, telemetry: string) {
  return runSymnavBinary(overviewArgs, {
    cwd: fixtureRoot,
    env: {
      SYMNAV_STATE_DIR: stateDir,
      SYMNAV_TELEMETRY: telemetry,
    },
  });
}

function newStateDir(): string {
  return join(mkdtempSync(join(tmpdir(), "symnav-telemetry-e2e-")), ".symnav");
}

function usageLogPath(stateDir: string): string {
  return join(stateDir, "usage.jsonl");
}

function singleUsageLine(stateDir: string): string {
  const lines = readFileSync(usageLogPath(stateDir), "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0]!;
}
