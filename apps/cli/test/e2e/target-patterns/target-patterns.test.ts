import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { expectIdentity } from "../expect-identity.js";
import { FixtureRunner } from "../fixture-runner.js";
import type { JsonIdentity } from "../json-identity.js";
import { type SymbolCommand, symbolCommands } from "../symbol-command.js";

const fixtureRunner = new FixtureRunner("target-pattern-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

const helperId = "src/unique/helper.ts::helper";
const orderChargeId = "src/domain/orders.ts::PaymentProcessor::charge";
const insideFoldId = "src/folded/folded.ts::insideFold";
const formatChargeId = "src/domain/orders.ts::PaymentProcessor::charge::formatCharge";
const routerPostId = "src/routing/router.ts::Router::post";
const adapterChargeId = "src/adapters/orders.ts::charge";

const sharedTargets = [
  ["helper", helperId],
  ["domain/orders.ts::charge", orderChargeId],
  ["orders.ts::PaymentProcessor::charge", orderChargeId],
  [orderChargeId, orderChargeId],
  ["insideFold", insideFoldId],
  ["formatCharge", formatChargeId],
] as const;

const overloadTargets = [
  ["routing/router.ts::Router::post#1", `${routerPostId}#1`],
  ["post", routerPostId],
] as const;

const overloadCases = symbolCommands.flatMap((command) =>
  overloadTargets.map(([target, canonicalId]) => [command, target, canonicalId] as const),
);

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
  enclosingSymbol?: JsonIdentity;
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

  it.each(overloadCases)("%s resolves overload target %s", (command, target, canonicalId) => {
    const parsed = runJson<JsonResolvedTarget>(command, [target]);
    expectIdentity(parsed.identity, canonicalId);
  });

  it.each(symbolCommands)("%s rejects a target inside an ignored file", (command) => {
    const result = runCommand(command, ["src/ignored-stuff.ts::HiddenProcessor"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Cannot answer: src/ignored-stuff.ts is ignored by .gitignore.\n");
  });

  it.each(symbolCommands)("%s rejects a path-like suffix naming a missing file", (command) => {
    const result = runCommand(command, ["src/missing.ts::charge"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Cannot answer: file not found: src/missing.ts.\n");
  });

  it.each(symbolCommands)(
    "%s prints the same text for a bare name and its canonical id",
    async (command) => {
      const bareName = runCommand(command, ["helper"]);
      const canonicalId = runCommand(command, [helperId]);
      expect(bareName.stderr).toBe("");
      expect(bareName.status).toBe(0);
      expect(canonicalId.stdout).toBe(bareName.stdout);
      await expect(bareName.stdout).toMatchFileSnapshot(snapshot(`${command}-helper.expected.txt`));
    },
  );

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

  it.each(symbolCommands)(
    "%s resolves a file suffix plus full segment path to the one exact match",
    (command) => {
      const parsed = runJson<JsonResolvedTarget>(command, ["orders.ts::charge"]);
      expectIdentity(parsed.identity, adapterChargeId);
    },
  );

  it.skip.each(symbolCommands)(
    "%s rejects a regex target matching several symbols (--regex is resolve-only today)",
    async (command) => {
      const result = runCommand(command, ["charge$", "--regex"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      await expect(result.stderr).toMatchFileSnapshot(
        snapshot("ambiguous-regex-charge.expected.err"),
      );
    },
  );

  it.skip("attributes each reference to its enclosing symbol (refs payload carries no owner today)", () => {
    const parsed = runJson<JsonRefsResult>("refs", ["helper"]);
    expect(parsed.references.map((reference) => reference.enclosingSymbol)).toEqual([
      undefined,
      { file: "src/calls.ts", segments: [{ name: "useUniqueHelper" }] },
    ]);
  });

  it.each(symbolCommands)(
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

  it.each(symbolCommands)("%s names the raw target pattern for not-found targets", (command) => {
    const result = runCommand(command, ["missing"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('Cannot answer: no symbol target "missing" found.\n');
  });

  it("treats former malformed ids as target patterns", () => {
    const result = runCommand("def", ["not_an_id"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('Cannot answer: no symbol target "not_an_id" found.\n');
  });
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

  it.each(symbolCommands)(
    "%s names the raw target when line narrowing removes all candidates",
    (command) => {
      const result = runCommand(command, ["PaymentProcessor::charge", "--line", "99"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'Cannot answer: no symbol target "PaymentProcessor::charge" matching line 99.\n',
      );
    },
  );

  it.each(symbolCommands)(
    "%s separates a line-filtered target from a never-matched one",
    (command) => {
      const result = runCommand(command, ["helper", "--line", "99"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe('Cannot answer: no symbol target "helper" matching line 99.\n');
    },
  );
});

describe("target-pattern fold node rejection", () => {
  it.each(symbolCommands)("%s rejects copied fold headers as non-symbol targets", (command) => {
    const result = runCommand(command, ['describe("x")']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('Cannot answer: no symbol target "describe(\\"x\\")" found.\n');
    expect(result.stderr).not.toContain("Invalid symbol id");
  });

  it.skip.each(symbolCommands)(
    "%s names a copied fold header as a fold node (reports a plain not-found today)",
    (command) => {
      const result = runCommand(command, ['describe("x")']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'Cannot answer: describe("x") is a fold node, not a symbol; use overview --at for fold headers.\n',
      );
    },
  );
});

describe("target-pattern error vocabulary", () => {
  it.each(symbolCommands)("%s reports an empty segment as a target-pattern error", (command) => {
    const result = runCommand(command, ["::charge"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Cannot answer: invalid symbol target (empty path segment between "::" separators): "::charge".\n',
    );
  });

  it.each(symbolCommands)(
    "%s reports a slashless missing-file suffix like a slashed one",
    (command) => {
      const result = runCommand(command, ["missing.ts::charge"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Cannot answer: file not found: missing.ts.\n");
    },
  );
});

describe("target-pattern ambiguity hints", () => {
  it.each(symbolCommands)("%s points at the way out of an ambiguous target", (command) => {
    const result = runCommand(command, ["PaymentProcessor::charge"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Copy a candidate id, or narrow with --line.");
  });
});
