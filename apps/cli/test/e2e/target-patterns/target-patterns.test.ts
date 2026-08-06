import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEGMENT_SEPARATOR, parseSegment } from "@symnav/core";

import { FixtureRunner } from "../fixture-runner.js";
import type { JsonIdentity } from "../json-identity.js";

const fixtureRunner = new FixtureRunner("target-pattern-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

const helperId = "src/unique/helper.ts::helper";
const orderChargeId = "src/domain/orders.ts::PaymentProcessor::charge";
const insideFoldId = "src/folded/folded.ts::insideFold";
const formatChargeId = "src/domain/orders.ts::PaymentProcessor::charge::formatCharge";

type SymbolCommand = "def" | "refs" | "context" | "graph";

const sharedTargets = [
  ["helper", helperId],
  ["domain/orders.ts::charge", orderChargeId],
  ["orders.ts::PaymentProcessor::charge", orderChargeId],
  [orderChargeId, orderChargeId],
  ["insideFold", insideFoldId],
  ["formatCharge", formatChargeId],
] as const;

interface JsonResolvedTarget {
  identity: JsonIdentity;
}

interface JsonDefResult extends JsonResolvedTarget {
  symbols: readonly unknown[];
}

interface JsonRefsResult extends JsonResolvedTarget {
  references: readonly JsonReference[];
}

interface JsonContextResult extends JsonResolvedTarget {
  references: { total: number };
  callers: { sortedEdges: readonly unknown[] };
  callees: { sortedEdges: readonly unknown[] };
}

interface JsonGraphResult extends JsonResolvedTarget {
  root: { identity: JsonIdentity };
  incoming: { totalPathCount: number };
  outgoing: { totalPathCount: number };
}

interface JsonReference {
  file: string;
  line: number;
  kind: string;
  matchStart: number;
}

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runCommand(command: SymbolCommand, args: readonly string[]) {
  return fixtureRunner.run([command, ...args]);
}

function runJson<Result>(command: SymbolCommand, args: readonly string[]): Result {
  const result = runCommand(command, [...args, "--json"]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Result;
}

function expectIdentity(identity: JsonIdentity, canonicalId: string): void {
  const [file, ...segments] = canonicalId.split(SEGMENT_SEPARATOR);
  expect(identity).toEqual({
    file,
    segments: segments.map((segment) => parseSegment(segment, canonicalId)),
  });
}

describe("target-pattern symbol commands", () => {
  it.each(sharedTargets)("def resolves %s", (target, canonicalId) => {
    const parsed = runJson<JsonDefResult>("def", [target]);
    expectIdentity(parsed.identity, canonicalId);
    expect(parsed.symbols.length).toBeGreaterThan(0);
  });

  it.each(sharedTargets)("refs resolves %s", (target, canonicalId) => {
    const parsed = runJson<JsonRefsResult>("refs", [target]);
    expectIdentity(parsed.identity, canonicalId);
    expect(parsed.references.length).toBeGreaterThan(0);
  });

  it.each(sharedTargets)("context resolves %s", (target, canonicalId) => {
    const parsed = runJson<JsonContextResult>("context", [target]);
    expectIdentity(parsed.identity, canonicalId);
    expect(parsed.references.total).toBeGreaterThan(0);
    expect(parsed.callers.sortedEdges.length + parsed.callees.sortedEdges.length).toBeGreaterThan(
      0,
    );
  });

  it.each(sharedTargets)("graph resolves %s", (target, canonicalId) => {
    const parsed = runJson<JsonGraphResult>("graph", [target]);
    expectIdentity(parsed.identity, canonicalId);
    expectIdentity(parsed.root.identity, canonicalId);
    expect(parsed.incoming.totalPathCount + parsed.outgoing.totalPathCount).toBeGreaterThan(0);
  });

  it("renders JSON identity for a unique def pattern", () => {
    const parsed = runJson<JsonDefResult>("def", ["orders.ts::PaymentProcessor::charge"]);
    expectIdentity(parsed.identity, orderChargeId);
    expect(parsed.symbols).toHaveLength(1);
  });

  it("keeps refs sorted for suffix-pattern targets", () => {
    const parsed = runJson<JsonRefsResult>("refs", ["helper"]);
    expectIdentity(parsed.identity, helperId);
    expect(parsed.references).toEqual([
      {
        file: "src/calls.ts",
        line: 4,
        previewSource: 'import { helper } from "./unique/helper";',
        matchStart: 9,
        matchEnd: 15,
        kind: "import",
      },
      {
        file: "src/calls.ts",
        line: 21,
        previewSource: "  return helper();",
        matchStart: 9,
        matchEnd: 15,
        kind: "usage",
      },
    ]);
  });

  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s rejects ambiguous basename suffixes with the shared candidate output",
    async (command) => {
      const result = runCommand(command, ["orders.ts::charge"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      await expect(result.stderr).toMatchFileSnapshot(
        snapshot("ambiguous-orders-charge.expected.err"),
      );
    },
  );

  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s rejects ambiguous segment suffixes with the shared candidate output",
    async (command) => {
      const result = runCommand(command, ["PaymentProcessor::charge"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      await expect(result.stderr).toMatchFileSnapshot(
        snapshot("ambiguous-payment-processor-charge.expected.err"),
      );
    },
  );

  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s names the raw target pattern for not-found targets",
    (command) => {
      const result = runCommand(command, ["missing"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe('Cannot answer: no symbol target "missing" found.\n');
    },
  );

  it("treats former malformed ids as target patterns", () => {
    const result = runCommand("def", ["not_an_id"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('Cannot answer: no symbol target "not_an_id" found.\n');
  });

  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s help exposes line narrowing",
    (command) => {
      const result = runCommand(command, ["--help"]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--line <n>");
      expect(result.stdout).toContain("narrow target matches to declarations containing this line");
    },
  );
});

describe("target-pattern line narrowing", () => {
  it.each<SymbolCommand>(["def", "refs", "context"])(
    "%s narrows an ambiguous target to a declaration containing the requested line",
    (command) => {
      const parsed = runJson<JsonResolvedTarget>(command, [
        "PaymentProcessor::charge",
        "--line",
        "5",
      ]);
      expectIdentity(parsed.identity, orderChargeId);
    },
  );

  it("graph narrows an ambiguous target to a declaration containing the requested line", () => {
    const parsed = runJson<JsonGraphResult>("graph", ["PaymentProcessor::charge", "--line", "5"]);
    expectIdentity(parsed.identity, orderChargeId);
    expectIdentity(parsed.root.identity, orderChargeId);
  });

  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s names the raw target when line narrowing removes all candidates",
    (command) => {
      const result = runCommand(command, ["PaymentProcessor::charge", "--line", "99"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'Cannot answer: no symbol target "PaymentProcessor::charge" found.\n',
      );
    },
  );
});

describe("target-pattern fold node rejection", () => {
  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s rejects copied fold headers as non-symbol targets",
    (command) => {
      const result = runCommand(command, ['describe("x")']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe('Cannot answer: no symbol target "describe(\\"x\\")" found.\n');
      expect(result.stderr).not.toContain("Invalid symbol id");
    },
  );
});
