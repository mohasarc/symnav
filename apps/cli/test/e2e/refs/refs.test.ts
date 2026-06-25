import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../overview/ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("refs-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;
const processorId = "src/payments/PaymentProcessor.ts::PaymentProcessor";
const controlFlowTargetId = "src/control-flow/ControlFlowTarget.ts::controlFlowTarget";

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runRefs(args: readonly string[]) {
  return runSymnavBinary(["refs", ...args], { cwd: fixtureRoot });
}

interface JsonReference {
  file: string;
  line: number;
  kind: string;
  matchStart: number;
  matchEnd: number;
}

interface JsonRefsResult {
  identity: { file: string; segments: readonly { name: string }[] };
  total: number;
  kindCounts: Record<string, number>;
  page: number;
  pageCount: number;
  references: readonly JsonReference[];
}

function parseJsonRefs(stdout: string): JsonRefsResult {
  return JSON.parse(stdout) as JsonRefsResult;
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav refs e2e (default output)", () => {
  it("renders the header and collapsed tree across files and kinds", async () => {
    const r = runRefs([processorId]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("payment-processor.expected.txt"));
  });

  it("excludes the definition and totals only true references", () => {
    const r = runRefs([processorId]);
    expect(r.stdout).not.toContain("export class PaymentProcessor");
    expect(r.stdout).toContain("Total: 14");
  });

  it("tags barrel re-exports [export] and still lists barrel consumers", () => {
    const r = runRefs([processorId]);
    expect(r.stdout).toContain('export { PaymentProcessor } from "./PaymentProcessor";  [export]');
    expect(r.stdout).toContain('import { PaymentProcessor } from "../payments";  [import]');
  });

  it("tags references in test-looking files as plain usage", () => {
    const r = runRefs([processorId]);
    expect(r.stdout).toContain("const sut = new PaymentProcessor();  [usage]");
  });

  it("excludes references inside ignored files", () => {
    const r = runRefs([processorId]);
    expect(r.stdout).not.toContain("ignored-stuff");
    expect(r.stdout).not.toContain("hiddenProcessor");
  });

  it("lists two same-line references as separate entries", () => {
    const r = runRefs([processorId]);
    const sameLineEntries = r.stdout
      .split("\n")
      .filter((line) => line.includes("3: export const processors"));
    expect(sameLineEntries).toHaveLength(2);
    for (const entry of sameLineEntries) {
      expect(entry).toContain("[usage]");
    }
  });

  it("lists references nested inside executable control-flow blocks", () => {
    const r = runRefs([controlFlowTargetId, "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseJsonRefs(r.stdout);
    expect(parsed.total).toBe(4);
    expect(parsed.kindCounts).toEqual({ usage: 3, import: 1, export: 0, type: 0 });
    expect(
      parsed.references.map((reference) => [reference.file, reference.line, reference.kind]),
    ).toEqual([
      ["src/control-flow/ControlFlowReferences.ts", 1, "import"],
      ["src/control-flow/ControlFlowReferences.ts", 5, "usage"],
      ["src/control-flow/ControlFlowReferences.ts", 10, "usage"],
      ["src/control-flow/ControlFlowReferences.ts", 15, "usage"],
    ]);
  });
});

describe("symnav refs e2e (preview trimming)", () => {
  it("trims long lines with an ellipsis while keeping the match visible", () => {
    const r = runRefs([processorId]);
    const lines = r.stdout.split("\n");
    const earlyEntry = lines.find((line) => line.includes("earlyProcessor"));
    const lateEntry = lines.find((line) => line.includes("processor: new PaymentProcessor() }"));
    for (const entry of [earlyEntry, lateEntry]) {
      expect(entry).toBeDefined();
      expect(entry).toContain("…");
      expect(entry).toContain("new PaymentProcessor()");
    }
  });

  it("emits verbatim lines with --full-lines", async () => {
    const r = runRefs([processorId, "--full-lines"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("…");
    expect(r.stdout).toContain("    this.processor = new PaymentProcessor();");
    await expect(r.stdout).toMatchFileSnapshot(
      snapshot("payment-processor-full-lines.expected.txt"),
    );
  });
});

describe("symnav refs e2e (zero references)", () => {
  it("renders Total: 0 with no kinds line and no tree", async () => {
    const r = runRefs(["src/payments/PaymentProcessor.ts::UnusedAuditLog"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("zero-references.expected.txt"));
  });
});

describe("symnav refs e2e (pagination)", () => {
  it("slices page 1 with --page-size 3", async () => {
    const r = runRefs([processorId, "--page-size", "3"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("payment-processor-page-1.expected.txt"));
  });

  it("slices page 2 with --page-size 3", async () => {
    const r = runRefs([processorId, "--page", "2", "--page-size", "3"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("payment-processor-page-2.expected.txt"));
  });

  it("keeps page reference sets disjoint", () => {
    const page1 = parseJsonRefs(runRefs([processorId, "--page-size", "3", "--json"]).stdout);
    const page2 = parseJsonRefs(
      runRefs([processorId, "--page", "2", "--page-size", "3", "--json"]).stdout,
    );
    const keyOf = (ref: JsonReference) => `${ref.file}:${ref.line}:${ref.matchStart}`;
    const page1Keys = new Set(page1.references.map(keyOf));
    for (const reference of page2.references) {
      expect(page1Keys.has(keyOf(reference))).toBe(false);
    }
  });

  it("produces byte-identical output across repeated runs", () => {
    const first = runRefs([processorId, "--page", "2", "--page-size", "3"]);
    const second = runRefs([processorId, "--page", "2", "--page-size", "3"]);
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });
});

describe("symnav refs e2e (errors)", () => {
  it("rejects an out-of-range page naming the page count", () => {
    const r = runRefs([processorId, "--page", "99", "--page-size", "3"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cannot answer: page 99 is out of range (1-5)");
  });

  it.each(["0", "-1", "1.5"])("rejects a page that is not a positive integer (%s)", (page) => {
    const r = runRefs([processorId, "--page", page]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`page must be a positive integer, got ${page}`);
  });

  it("rejects --all combined with an explicit page", () => {
    const r = runRefs([processorId, "--all", "--page", "2"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cannot answer:");
  });

  it("rejects a symbol path that matches nothing in the file", () => {
    const r = runRefs(["src/payments/PaymentProcessor.ts::Nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "Cannot answer: no symbol src/payments/PaymentProcessor.ts::Nonexistent found",
    );
  });

  it("rejects a malformed symbol id", () => {
    const r = runRefs(["not_an_id"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cannot answer: invalid symbol id");
  });

  it("rejects a nonexistent file", () => {
    const r = runRefs(["src/missing.ts::Whatever"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("file not found");
  });

  it("rejects a path inside an ignored file", () => {
    const r = runRefs(["src/ignored-stuff.ts::hiddenProcessor"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("ignored");
  });
});

describe("symnav refs e2e (JSON output)", () => {
  it("emits a parseable result with totals, kind counts, and references", () => {
    const r = runRefs([processorId, "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseJsonRefs(r.stdout);
    expect(parsed.identity).toEqual({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }],
    });
    expect(parsed.total).toBe(14);
    expect(parsed.kindCounts).toEqual({ usage: 7, import: 5, export: 1, type: 1 });
    expect(parsed.page).toBe(1);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.references).toHaveLength(14);
    expect(parsed.references[0]).toMatchObject({
      file: "src/billing/RefundService.ts",
      line: 1,
      kind: "import",
      matchStart: 9,
      matchEnd: 25,
    });
  });
});
