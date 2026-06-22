import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, UsageAggregator, type Outcome, type UsageEvent } from "@symnav/telemetry";
import { buildProgram } from "../../../../src/program.js";
import type { ProgramContext } from "../../../../src/program-context.js";
import { fakeDependencies } from "../helpers/fake-program-dependencies.js";
import { BufferStream } from "../helpers/fake-program-context.js";

async function parse(argv: readonly string[], stateDir: string): Promise<CommandResult> {
  const previousStateDir = process.env.SYMNAV_STATE_DIR;
  process.env.SYMNAV_STATE_DIR = stateDir;

  try {
    const context = createStatsProgramContext();
    const program = buildProgram(context, fakeDependencies());
    try {
      await program.parseAsync([...argv], { from: "user" });
    } catch (error) {
      if (!(error instanceof CapturedExit)) {
        throw error;
      }
    }
    return {
      stdout: context.stdout.text(),
      stderr: context.stderr.text(),
      exitCodes: context.exitCodes,
    };
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.SYMNAV_STATE_DIR;
    } else {
      process.env.SYMNAV_STATE_DIR = previousStateDir;
    }
  }
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCodes: readonly number[];
}

interface StatsProgramContext extends ProgramContext {
  stdout: BufferStream;
  stderr: BufferStream;
  readonly exitCodes: readonly number[];
}

class CapturedExit extends Error {}

function createStatsProgramContext(): StatsProgramContext {
  const stdout = new BufferStream();
  const stderr = new BufferStream();
  const exitCodes: number[] = [];
  const exit: ProgramContext["exit"] = (code) => {
    exitCodes.push(code);
    throw new CapturedExit();
  };
  return {
    stdout,
    stderr,
    cwd: "/repo",
    exit,
    exitCodes,
  };
}

describe("symnav stats", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it("is hidden from top-level help", async () => {
    const stateDir = tempStateDir(roots);
    const result = await parse(["--help"], stateDir);

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([0]);
    expect(result.stdout).toContain("overview");
    expect(result.stdout).toContain("resolve");
    expect(result.stdout).toContain("def");
    expect(result.stdout).toContain("refs");
    expect(result.stdout).not.toContain("stats");
  });

  it("renders a text summary from the usage log", async () => {
    const stateDir = tempStateDir(roots);
    seedUsageLog(stateDir, seededEvents());

    const result = await parse(["stats"], stateDir);

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(result.stdout).toContain("Usage summary");
    expect(result.stdout).toContain("Total events: 6");
    expect(result.stdout).toContain("overview  3  50.0%");
    expect(result.stdout).toContain("def       2  33.3%");
    expect(result.stdout).toContain("refs      1  16.7%");
    expect(result.stdout).toContain("success     3");
    expect(result.stdout).toContain("user_error  2");
    expect(result.stdout).toContain("crash       1");
    expect(result.stdout).toContain("Average: 66.7ms");
    expect(result.stdout).toContain("P50: 30.0ms");
    expect(result.stdout).toContain("P95: 200.0ms");
    expect(result.stdout).toContain("Distinct workspaces: 3");
    expect(result.stdout).toContain("0.2.0  3");
    expect(result.stdout).toContain("0.1.0  2");
    expect(result.stdout).toContain("0.3.0  1");
    expect(result.stdout).toContain(
      "Date range: 1970-01-01T00:00:00.100Z to 1970-01-01T00:00:00.900Z",
    );
  });

  it("renders raw UsageSummary JSON with --json", async () => {
    const stateDir = tempStateDir(roots);
    const events = seededEvents();
    seedUsageLog(stateDir, events);

    const result = await parse(["stats", "--json"], stateDir);

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(JSON.parse(result.stdout)).toEqual(new UsageAggregator(events).aggregate());
  });

  it("renders a clean empty summary when the usage log is missing", async () => {
    const stateDir = tempStateDir(roots);
    const usageFilePath = join(stateDir, "usage.jsonl");

    const result = await parse(["stats"], stateDir);

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(result.stdout).toBe("No usage events recorded.\n");
    expect(existsSync(usageFilePath)).toBe(false);
  });

  it("does not record itself", async () => {
    const stateDir = tempStateDir(roots);
    const events = seededEvents();
    const usageFilePath = seedUsageLog(stateDir, events);
    const lineCountBefore = lineCount(usageFilePath);

    const result = await parse(["stats"], stateDir);

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(lineCount(usageFilePath)).toBe(lineCountBefore);
  });
});

function tempStateDir(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-stats-"));
  roots.push(root);
  return root;
}

function seedUsageLog(stateDir: string, events: readonly UsageEvent[]): string {
  const usageFilePath = join(stateDir, "usage.jsonl");
  writeFileSync(
    usageFilePath,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  return usageFilePath;
}

function lineCount(filePath: string): number {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line !== "").length;
}

function seededEvents(): readonly UsageEvent[] {
  return [
    usageEvent({
      command: "overview",
      durationMs: 10,
      outcome: "success",
      symnavVersion: "0.2.0",
      timestamp: 500,
      workspaceId: "workspace-a",
    }),
    usageEvent({
      command: "def",
      durationMs: 20,
      outcome: "user_error",
      symnavVersion: "0.1.0",
      timestamp: 100,
      workspaceId: "workspace-b",
    }),
    usageEvent({
      command: "overview",
      durationMs: 30,
      outcome: "success",
      symnavVersion: "0.2.0",
      timestamp: 300,
      workspaceId: "workspace-a",
    }),
    usageEvent({
      command: "refs",
      durationMs: 40,
      outcome: "crash",
      symnavVersion: "0.1.0",
      timestamp: 900,
      workspaceId: "workspace-c",
    }),
    usageEvent({
      command: "def",
      durationMs: 100,
      outcome: "user_error",
      symnavVersion: "0.2.0",
      timestamp: 700,
      workspaceId: "workspace-b",
    }),
    usageEvent({
      command: "overview",
      durationMs: 200,
      outcome: "success",
      symnavVersion: "0.3.0",
      timestamp: 200,
      workspaceId: "workspace-c",
    }),
  ];
}

function usageEvent(overrides: UsageEventOverrides): UsageEvent {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    symnavVersion: overrides.symnavVersion,
    command: overrides.command,
    timestamp: overrides.timestamp,
    durationMs: overrides.durationMs,
    argShape: {
      kind: "path",
      lengthBucket: "medium",
      flags: [],
    },
    workspaceId: overrides.workspaceId,
    machineId: "machine",
    sessionId: "session",
  } satisfies Partial<UsageEvent>;

  if (overrides.outcome === "success") {
    return { ...base, outcome: "success" };
  }

  return { ...base, outcome: overrides.outcome, errorReason: "reason" };
}

interface UsageEventOverrides {
  readonly command: string;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly symnavVersion: string;
  readonly timestamp: number;
  readonly workspaceId: string;
}
