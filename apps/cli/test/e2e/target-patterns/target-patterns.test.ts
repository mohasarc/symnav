import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";
import type { JsonIdentity } from "../json-identity.js";

const fixtureRunner = new FixtureRunner("target-pattern-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

const helperId = "src/unique/helper.ts::helper";
const orderChargeId = "src/domain/orders.ts::PaymentProcessor::charge";
const insideFoldId = "src/folded/folded.ts::insideFold";

type SymbolCommand = "def" | "refs" | "context" | "graph";

interface JsonCommandResult {
  identity: JsonIdentity;
  root?: { identity: JsonIdentity };
  symbols?: readonly unknown[];
  references?: readonly JsonReference[] | { total: number };
  callers?: { sortedEdges: readonly unknown[] };
  callees?: { sortedEdges: readonly unknown[] };
  incoming?: { totalPathCount: number; paths: readonly { steps: readonly unknown[] }[] };
  outgoing?: { totalPathCount: number; paths: readonly { steps: readonly unknown[] }[] };
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

function runJson(command: SymbolCommand, target: string): JsonCommandResult {
  const result = runCommand(command, [target, "--json"]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as JsonCommandResult;
}

function expectIdentity(identity: JsonIdentity, canonicalId: string): void {
  const [file, ...segments] = canonicalId.split("::");
  expect(identity).toEqual({
    file,
    segments: segments.map((name) => ({ name })),
  });
}

function expectCommandResolved(command: SymbolCommand, target: string, canonicalId: string): void {
  const parsed = runJson(command, target);
  expectIdentity(parsed.identity, canonicalId);

  if (command === "def") {
    expect(parsed.symbols?.length).toBeGreaterThan(0);
  }

  if (command === "refs") {
    expect(Array.isArray(parsed.references)).toBe(true);
    expect((parsed.references as readonly unknown[]).length).toBeGreaterThan(0);
  }

  if (command === "context") {
    expect(parsed.references).toMatchObject({ total: expect.any(Number) });
    expect((parsed.references as { total: number }).total).toBeGreaterThan(0);
    expect(
      (parsed.callers?.sortedEdges.length ?? 0) + (parsed.callees?.sortedEdges.length ?? 0),
    ).toBeGreaterThan(0);
  }

  if (command === "graph") {
    expect(parsed.root).toBeDefined();
    expectIdentity(parsed.root!.identity, canonicalId);
    expect(
      (parsed.incoming?.totalPathCount ?? 0) + (parsed.outgoing?.totalPathCount ?? 0),
    ).toBeGreaterThan(0);
  }
}

describe("target-pattern symbol commands", () => {
  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s resolves shared suffix-pattern targets",
    (command) => {
      const cases = [
        ["helper", helperId],
        ["domain/orders.ts::charge", orderChargeId],
        ["orders.ts::PaymentProcessor::charge", orderChargeId],
        [orderChargeId, orderChargeId],
        ["insideFold", insideFoldId],
      ] as const;

      for (const [target, canonicalId] of cases) {
        expectCommandResolved(command, target, canonicalId);
      }
    },
  );

  it("renders JSON identity for a unique def pattern", () => {
    const parsed = runJson("def", "orders.ts::PaymentProcessor::charge");
    expectIdentity(parsed.identity, orderChargeId);
    expect(parsed.symbols).toHaveLength(1);
  });

  it("keeps refs sorted for suffix-pattern targets", () => {
    const parsed = runJson("refs", "helper");
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
  it.each<SymbolCommand>(["def", "refs", "context", "graph"])(
    "%s narrows an ambiguous target to a declaration containing the requested line",
    (command) => {
      const result = runCommand(command, ["PaymentProcessor::charge", "--line", "5", "--json"]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const parsed = JSON.parse(result.stdout) as JsonCommandResult;
      expectIdentity(parsed.identity, orderChargeId);
      if (command === "graph") {
        expect(parsed.root).toBeDefined();
        expectIdentity(parsed.root!.identity, orderChargeId);
      }
    },
  );

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
