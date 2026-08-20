import { describe, expect, it } from "vitest";

import { runOverview, snapshot } from "./run-overview.js";

interface JsonOverviewNode {
  readonly type: string;
  readonly children: readonly JsonOverviewNode[];
  readonly header: { readonly lines: readonly string[] };
  readonly range: { readonly startLine: number; readonly endLine: number };
}

interface JsonOverviewSymbolNode extends JsonOverviewNode {
  readonly identity: { readonly segments: readonly { readonly name: string }[] };
  readonly kind: { readonly role: string };
}

interface JsonOverviewResult {
  readonly file: string;
  readonly request: { readonly at?: string; readonly depth: number; readonly line?: number };
  readonly entries: readonly JsonOverviewNode[];
}

function parseOverview(stdout: string): JsonOverviewResult {
  return JSON.parse(stdout) as JsonOverviewResult;
}

function symbolChildrenOf(node: JsonOverviewNode | undefined): readonly JsonOverviewSymbolNode[] {
  return (node?.children ?? []) as readonly JsonOverviewSymbolNode[];
}

describe("symnav overview e2e (targeting)", () => {
  it("renders only top-level nodes at explicit depth zero", async () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "0"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-3: describe("setup", () => {');
    expect(r.stdout).toContain('5-11: describe("cursor", () => {');
    expect(r.stdout).toContain("13-18: action");
    expect(r.stdout).not.toContain("setupHelper");
    expect(r.stdout).not.toContain("cursorHelper");
    expect(r.stdout).not.toContain('8-10: describe("nested", () => {');
    expect(r.stdout).not.toContain("14-17: if (flag) {");
    expect(r.stdout).not.toContain("branchValue");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("targeted-expansion-depth-0.expected.txt"));
  });

  it("defaults to explicit depth zero", () => {
    expect(runOverview(["overview", "targeted-expansion.ts"]).stdout).toBe(
      runOverview(["overview", "targeted-expansion.ts", "--depth", "0"]).stdout,
    );
  });

  it("renders one child level globally at depth one", async () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2: setupHelper");
    expect(r.stdout).toContain("6: cursorHelper");
    expect(r.stdout).toContain('8-10: describe("nested", () => {');
    expect(r.stdout).toContain("14-17: if (flag) {");
    expect(r.stdout).not.toContain("9: innerHelper");
    expect(r.stdout).not.toContain("15: action::branchValue");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("targeted-expansion-depth-1.expected.txt"));
  });

  it("renders two child levels globally at depth two", async () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "2"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2: setupHelper");
    expect(r.stdout).toContain("6: cursorHelper");
    expect(r.stdout).toContain("9: innerHelper");
    expect(r.stdout).toContain("15: action::branchValue");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("targeted-expansion-depth-2.expected.txt"));
  });

  it("renders only a copied fold header target at depth zero", () => {
    const r = runOverview([
      "overview",
      "targeted-expansion.ts",
      "--at",
      'describe("cursor")',
      "--depth",
      "0",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('5-11: describe("cursor", () => {');
    expect(r.stdout).not.toContain("6: cursorHelper");
    expect(r.stdout).not.toContain('8-10: describe("nested", () => {');
    expect(r.stdout).not.toContain('describe("setup"');
    expect(r.stdout).not.toContain("innerHelper");
  });

  it("renders one child level inside a copied fold header target at depth one", () => {
    const r = runOverview([
      "overview",
      "targeted-expansion.ts",
      "--at",
      'describe("cursor")',
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('5-11: describe("cursor", () => {');
    expect(r.stdout).toContain("6: cursorHelper");
    expect(r.stdout).toContain('8-10: describe("nested", () => {');
    expect(r.stdout).not.toContain('describe("setup"');
    expect(r.stdout).not.toContain("innerHelper");
  });

  it("targets an async callback fold by its closed call form", () => {
    const r = runOverview([
      "overview",
      "async-callbacks.ts",
      "--at",
      'describe("beta")',
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-3: describe("beta", async () => {');
    expect(r.stdout).toContain("2: betaHelper");
    expect(r.stdout).not.toContain("gamma");
  });

  it("targets a parameterized callback fold by its closed call form", () => {
    const r = runOverview([
      "overview",
      "async-callbacks.ts",
      "--at",
      'describe("gamma")',
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('5-7: describe("gamma", (t) => {');
    expect(r.stdout).toContain("6: gammaHelper");
    expect(r.stdout).not.toContain("beta");
  });

  it("targets a fold via its rendered capped header line", () => {
    const longHeaderLine =
      'describe("a very long suite title that overflows the eighty character header render cap", () => {';
    expect(longHeaderLine.length).toBeGreaterThan(80);
    const cappedLabel = longHeaderLine.slice(0, 79) + "…";

    const listing = runOverview(["overview", "long-header.ts"]);
    expect(listing.stderr).toBe("");
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain(cappedLabel);
    expect(listing.stdout).not.toContain("longHelper");

    const r = runOverview(["overview", "long-header.ts", "--at", cappedLabel, "--depth", "1"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2: longHelper");
  });

  it("targets a nested fold by copied header substring before trimming depth", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--at", "nested", "--depth", "0"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('8-10: describe("nested", () => {');
    expect(r.stdout).not.toContain("9: innerHelper");
    expect(r.stdout).not.toContain('describe("setup"');
    expect(r.stdout).not.toContain('describe("cursor"');
  });

  it("renders only a copied class header target at depth zero", () => {
    const r = runOverview([
      "overview",
      "class-with-methods.ts",
      "--at",
      "1-9: Greeter",
      "--depth",
      "0",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1-9: Greeter");
    expect(r.stdout).not.toContain("Greeter::greet");
    expect(r.stdout).not.toContain("Greeter::shout");
  });

  it("renders one member level inside a copied class header target at depth one", () => {
    const r = runOverview([
      "overview",
      "class-with-methods.ts",
      "--at",
      "1-9: Greeter",
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1-9: Greeter");
    expect(r.stdout).toContain("Greeter::greet");
    expect(r.stdout).toContain("Greeter::shout");
  });

  it("targets a class by its bare name", () => {
    const r = runOverview(["overview", "class-with-methods.ts", "--at", "Greeter", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1-9: Greeter");
    expect(r.stdout).toContain("Greeter::greet");
    expect(r.stdout).toContain("Greeter::shout");
  });

  it("prints target candidates for ambiguous header text", async () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--at", "describe"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Cannot answer: overview target matches multiple nodes.");
    expect(r.stderr).toContain('1-3: describe("setup", () => {');
    expect(r.stderr).toContain('5-11: describe("cursor", () => {');
    expect(r.stderr).toContain('8-10: describe("nested", () => {');
    await expect(r.stderr).toMatchFileSnapshot(
      snapshot("targeted-expansion-ambiguous-at.expected.err"),
    );
  });

  it("reports missing target text", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--at", "missing"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('Cannot answer: no overview target matching --at "missing".\n');
  });

  it("renders children of a line-narrowed target at depth one", () => {
    const r = runOverview(["overview", "line-narrowing.ts", "--line", "10", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('10-12: describe("repeated", () => {');
    expect(r.stdout).toContain("11: secondHelper");
    expect(r.stdout).not.toContain("firstHelper");
  });

  it("narrows a line-only target to one candidate", () => {
    const r = runOverview(["overview", "line-narrowing.ts", "--line", "10", "--depth", "0"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('10-12: describe("repeated", () => {');
    expect(r.stdout).not.toContain("11: secondHelper");
    expect(r.stdout).not.toContain("firstHelper");
  });

  it("keeps same-line targets ambiguous under line-only narrowing", async () => {
    const r = runOverview(["overview", "line-narrowing.ts", "--line", "14"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "Cannot answer: line 14 matches multiple overview nodes; use --at with copied header text.",
    );
    expect(r.stderr).toContain('14: describe("inline", () => {');
    await expect(r.stderr).toMatchFileSnapshot(
      snapshot("line-narrowing-ambiguous-line.expected.err"),
    );
  });

  it.skip("expands one of two identical same-line folds (no selector distinguishes them today)", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "14",
      "--at",
      'describe("inline")',
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("14: inlineHelper");
  });

  it("renders children of a line and header selected duplicate at depth one", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "10",
      "--at",
      "repeated",
      "--depth",
      "1",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('10-12: describe("repeated", () => {');
    expect(r.stdout).toContain("11: secondHelper");
    expect(r.stdout).not.toContain("firstHelper");
  });

  it("uses line and header text to select one duplicate header", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "10",
      "--at",
      "repeated",
      "--depth",
      "0",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('10-12: describe("repeated", () => {');
    expect(r.stdout).not.toContain("11: secondHelper");
    expect(r.stdout).not.toContain("firstHelper");
  });

  it("serializes nested child nodes in JSON output at depth one", () => {
    const r = runOverview([
      "overview",
      "targeted-expansion.ts",
      "--at",
      'describe("cursor")',
      "--depth",
      "1",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.request).toEqual({ depth: 1, at: 'describe("cursor")' });
    expect(parsed.entries).toHaveLength(1);

    const [symbolChild, foldChild] = symbolChildrenOf(parsed.entries[0]);
    expect(symbolChild?.type).toBe("symbol");
    expect(symbolChild?.identity.segments).toEqual([{ name: "cursorHelper" }]);
    expect(symbolChild?.kind.role).toBe("value");
    expect(symbolChild?.range).toEqual({ startLine: 6, endLine: 6 });
    expect(symbolChild?.children).toEqual([]);
    expect(foldChild?.type).toBe("fold");
    expect(foldChild?.header.lines).toEqual(['describe("nested", () => {']);
    expect(foldChild?.range).toEqual({ startLine: 8, endLine: 10 });
    expect(foldChild?.children).toEqual([]);
  });

  it("includes expansion request metadata in JSON output", () => {
    const r = runOverview([
      "overview",
      "targeted-expansion.ts",
      "--at",
      'describe("cursor")',
      "--depth",
      "0",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.file).toBe("targeted-expansion.ts");
    expect(parsed.request).toEqual({ depth: 0, at: 'describe("cursor")' });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.header.lines).toEqual(['describe("cursor", () => {']);
    expect(parsed.entries[0]?.children).toEqual([]);
  });

  it("serializes class members in JSON output at depth one", () => {
    const r = runOverview([
      "overview",
      "class-with-methods.ts",
      "--at",
      "1-9: Greeter",
      "--depth",
      "1",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.entries).toHaveLength(1);
    expect(symbolChildrenOf(parsed.entries[0]).map((child) => child.identity.segments)).toEqual([
      [{ name: "Greeter" }, { name: "greet" }],
      [{ name: "Greeter" }, { name: "shout" }],
    ]);
    expect(symbolChildrenOf(parsed.entries[0]).map((child) => child.children)).toEqual([[], []]);
  });

  it("mirrors class target depth trimming in JSON output", () => {
    const r = runOverview([
      "overview",
      "class-with-methods.ts",
      "--at",
      "1-9: Greeter",
      "--depth",
      "0",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    const [entry] = parsed.entries as readonly JsonOverviewSymbolNode[];
    expect(parsed.entries).toHaveLength(1);
    expect(entry?.identity.segments).toEqual([{ name: "Greeter" }]);
    expect(entry?.children).toEqual([]);
  });

  it("includes line request metadata with children in JSON output at depth one", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "10",
      "--depth",
      "1",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.request).toEqual({ depth: 1, line: 10 });
    expect(parsed.entries).toHaveLength(1);
    expect(symbolChildrenOf(parsed.entries[0]).map((child) => child.identity.segments)).toEqual([
      [{ name: "secondHelper" }],
    ]);
  });

  it("includes line request metadata in JSON output", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "10",
      "--depth",
      "0",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.file).toBe("line-narrowing.ts");
    expect(parsed.request).toEqual({ depth: 0, line: 10 });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.header.lines).toEqual(['describe("repeated", () => {']);
    expect(parsed.entries[0]?.children).toEqual([]);
  });

  it("includes combined request metadata with children in JSON output at depth one", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "10",
      "--at",
      "repeated",
      "--depth",
      "1",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.request).toEqual({ at: "repeated", depth: 1, line: 10 });
    expect(parsed.entries).toHaveLength(1);
    expect(symbolChildrenOf(parsed.entries[0]).map((child) => child.identity.segments)).toEqual([
      [{ name: "secondHelper" }],
    ]);
  });

  it("includes combined line and header request metadata in JSON output", () => {
    const r = runOverview([
      "overview",
      "line-narrowing.ts",
      "--line",
      "10",
      "--at",
      "repeated",
      "--depth",
      "0",
      "--json",
    ]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = parseOverview(r.stdout);
    expect(parsed.file).toBe("line-narrowing.ts");
    expect(parsed.request).toEqual({ at: "repeated", depth: 0, line: 10 });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.header.lines).toEqual(['describe("repeated", () => {']);
    expect(parsed.entries[0]?.children).toEqual([]);
  });

  it("rejects malformed depth values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "x"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: depth must be a non-negative integer, got NaN.\n",
    );
  });

  it("rejects negative depth values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--depth", "-1"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: depth must be a non-negative integer, got -1.\n",
    );
  });

  it("rejects malformed line values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--line", "x"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: line must be a positive integer, got NaN.\n",
    );
  });

  it("rejects non-positive line values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--line", "0"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: line must be a positive integer, got 0.\n",
    );
  });

  it("rejects fractional line values as overview request errors", () => {
    const r = runOverview(["overview", "targeted-expansion.ts", "--line", "1.5"]);

    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "Cannot answer: invalid overview request: line must be a positive integer, got 1.5.\n",
    );
  });
});
