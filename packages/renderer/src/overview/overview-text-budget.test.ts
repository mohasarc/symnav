import { describe, expect, it } from "vitest";

import { OverviewTree, type OverviewNode } from "@symnav/core";

import { OverviewTextBudget } from "./overview-text-budget.js";

const LONG_LABEL_LENGTH = 100;
const DEPTH_ONE_WITH_FOOTER_CHARS = 137;

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
      "… more: --at '<label>' --depth <n> on a shown node",
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
});
