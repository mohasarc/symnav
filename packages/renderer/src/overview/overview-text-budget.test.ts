import { describe, expect, it } from "vitest";

import { OverviewTree, type OverviewNode } from "@symnav/core";

import { OverviewTextBudget } from "./overview-text-budget.js";

const LONG_LABEL_LENGTH = 100;
const DEPTH_ONE_WITH_FOOTER_CHARS = 147;
const TWO_TOP_LEVEL_ENTRIES_CHARS = 324;
const THREE_MEMBERS_CHARS = 159;
const ONE_DEPTH_TWO_NODE_CHARS = 311;
const MEMBER_COUNT = 400;
const CLASS_AND_ONE_ENTRY_CHARS = 271;
const TWO_SHORT_MEMBERS_CHARS = 148;
const LONG_MEMBER_REPEATS = 3;

function node(
  name: string,
  lines: { readonly start: number; readonly end: number },
  children: readonly OverviewNode[] = [],
): OverviewNode {
  return OverviewTree.symbol({
    identity: { file: "src/file.ts", segments: [{ name }] },
    kind: { role: "value", nativeLabel: "function" },
    range: { startLine: lines.start, endLine: lines.end },
    header: { startLine: lines.start, lines: [name] },
    children,
  });
}

function indentedLines(nodes: readonly OverviewNode[], depth: number): string {
  return nodes
    .map((entry) => {
      const line = `${"  ".repeat(depth)}${entry.header.lines[0]}\n`;
      if (entry.type === "re-export") return line;
      return line + indentedLines(entry.children, depth + 1);
    })
    .join("");
}

function renderTree(entries: readonly OverviewNode[]): string {
  return indentedLines(entries, 0);
}

function budgetOf(maxChars: number): OverviewTextBudget {
  return new OverviewTextBudget({ maxChars, renderTree });
}

function twoLevelTree(): readonly OverviewNode[] {
  const leaf = (prefix: string, line: number) =>
    node(`${prefix}${"x".repeat(LONG_LABEL_LENGTH)}`, { start: line, end: line });
  return [
    node("a", { start: 1, end: 10 }, [
      node("a1", { start: 2, end: 3 }, [leaf("a1", 3)]),
      node("a2", { start: 4, end: 5 }, [leaf("a2", 5)]),
    ]),
    node("b", { start: 11, end: 20 }, [
      node("b1", { start: 12, end: 13 }, [leaf("b1", 13)]),
      node("b2", { start: 14, end: 15 }, [leaf("b2", 15)]),
    ]),
  ];
}

function topLevelEntries(): readonly OverviewNode[] {
  return [1, 2, 3, 4, 5].map((line) =>
    node(`e${line}${"x".repeat(LONG_LABEL_LENGTH)}`, { start: line, end: line }),
  );
}

function enumWithMembers(): readonly OverviewNode[] {
  const members = Array.from({ length: MEMBER_COUNT }, (_, index) =>
    node(`m${String(index).padStart(3, "0")}`, { start: index + 2, end: index + 2 }),
  );
  return [node("E", { start: 1, end: MEMBER_COUNT + 2 }, members)];
}

function classBesideEntries(): readonly OverviewNode[] {
  const entries = [6, 7, 8, 9, 10].map((line) =>
    node(`l${line}${"x".repeat(LONG_LABEL_LENGTH)}`, { start: line, end: line }),
  );
  const widget = node("w", { start: 1, end: 5 }, [
    node("w1", { start: 2, end: 2 }),
    node("w2", { start: 3, end: 3 }),
  ]);
  return [widget, ...entries];
}

function parentsWithOneMemberEach(): readonly OverviewNode[] {
  const longMember = `c1${"x".repeat(LONG_LABEL_LENGTH * LONG_MEMBER_REPEATS)}`;
  return [
    node("a", { start: 1, end: 3 }, [node("a1", { start: 2, end: 2 })]),
    node("b", { start: 4, end: 6 }, [node("b1", { start: 5, end: 5 })]),
    node("c", { start: 7, end: 9 }, [node(longMember, { start: 8, end: 8 })]),
  ];
}

describe("OverviewTextBudget", () => {
  it("returns the rendered tree unchanged when it fits", () => {
    const entries = twoLevelTree();
    const rendered = renderTree(entries);

    expect(budgetOf(rendered.length).render(entries)).toBe(rendered);
  });

  it("keeps the deepest full depth that fits and says what it left out", () => {
    const expected = [
      "a",
      "  a1",
      "  a2",
      "b",
      "  b1",
      "  b2",
      `… cut to fit ${DEPTH_ONE_WITH_FOOTER_CHARS} chars: showing depth 1 of 2, 4 nodes omitted`,
      "… more: --at '<label>' --depth <n> on a shown node, or --all",
      "",
    ].join("\n");

    expect(expected).toHaveLength(DEPTH_ONE_WITH_FOOTER_CHARS);
    expect(budgetOf(DEPTH_ONE_WITH_FOOTER_CHARS).render(twoLevelTree())).toBe(expected);
  });

  it("counts the footer inside the budget", () => {
    const maxChars = DEPTH_ONE_WITH_FOOTER_CHARS - 1;

    const output = budgetOf(maxChars).render(twoLevelTree());

    expect(output.length).toBeLessThanOrEqual(maxChars);
    expect(output).toContain("showing depth 0 of 2");
  });

  it("cuts top-level entries in source order when depth 0 does not fit", () => {
    const x = "x".repeat(LONG_LABEL_LENGTH);
    const expected = [
      `e1${x}`,
      `e2${x}`,
      `… cut to fit ${TWO_TOP_LEVEL_ENTRIES_CHARS} chars: showing depth 0 through line 2, 3 nodes omitted`,
      "… omitted at depth 0: lines 3-5",
      "… more: --all",
      "",
    ].join("\n");

    expect(expected).toHaveLength(TWO_TOP_LEVEL_ENTRIES_CHARS);
    expect(budgetOf(TWO_TOP_LEVEL_ENTRIES_CHARS).render(topLevelEntries())).toBe(expected);
  });

  it("cuts a lone node's children in source order without pointing back at it", () => {
    const expected = [
      "E",
      "  m000",
      "  m001",
      "  m002",
      `… cut to fit ${THREE_MEMBERS_CHARS} chars: showing depth 0 of 1, depth 1 through line 4, 397 nodes omitted`,
      "… omitted at depth 1: lines 5-401",
      "… more: --all",
      "",
    ].join("\n");

    expect(expected).toHaveLength(THREE_MEMBERS_CHARS);
    expect(budgetOf(THREE_MEMBERS_CHARS).render(enumWithMembers())).toBe(expected);
  });

  it("fills the level below the deepest full depth in source order", () => {
    const expected = [
      "a",
      "  a1",
      `    a1${"x".repeat(LONG_LABEL_LENGTH)}`,
      "  a2",
      "b",
      "  b1",
      "  b2",
      `… cut to fit ${ONE_DEPTH_TWO_NODE_CHARS} chars: showing depth 1 of 2, depth 2 through line 3, 3 nodes omitted`,
      "… omitted at depth 2: lines 5-15",
      "… more: --at '<label>' --depth <n> on a shown node, or --all",
      "",
    ].join("\n");

    expect(expected).toHaveLength(ONE_DEPTH_TWO_NODE_CHARS);
    expect(budgetOf(ONE_DEPTH_TWO_NODE_CHARS).render(twoLevelTree())).toBe(expected);
  });

  it("points at --at when a shown node in the cut level has hidden children", () => {
    const expected = [
      "w",
      `l6${"x".repeat(LONG_LABEL_LENGTH)}`,
      `… cut to fit ${CLASS_AND_ONE_ENTRY_CHARS} chars: showing depth 0 through line 6, 6 nodes omitted`,
      "… omitted at depth 0: lines 7-10",
      "… more: --at '<label>' --depth <n> on a shown node, or --all",
      "",
    ].join("\n");

    expect(expected).toHaveLength(CLASS_AND_ONE_ENTRY_CHARS);
    expect(budgetOf(CLASS_AND_ONE_ENTRY_CHARS).render(classBesideEntries())).toBe(expected);
  });

  it("shows more cut-level nodes when a shorter footer makes room for them", () => {
    const expected = [
      "a",
      "  a1",
      "b",
      "  b1",
      "c",
      `… cut to fit ${TWO_SHORT_MEMBERS_CHARS} chars: showing depth 0 of 1, depth 1 through line 5, 1 nodes omitted`,
      "… omitted at depth 1: lines 8-8",
      "… more: --all",
      "",
    ].join("\n");

    expect(expected).toHaveLength(TWO_SHORT_MEMBERS_CHARS);
    expect(budgetOf(TWO_SHORT_MEMBERS_CHARS).render(parentsWithOneMemberEach())).toBe(expected);
  });
});
