import type { OverviewNode } from "@symnav/core";

export interface OverviewTextBudgetArgs {
  readonly maxChars: number;
  readonly renderTree: (entries: readonly OverviewNode[]) => string;
}

const NO_LEVELS_SHOWN = -1;
const AT_HINT = "--at '<label>' --depth <n> on a shown node";
const ALL_HINT = "--all";

export class OverviewTextBudget {
  private readonly maxChars: number;
  private readonly renderTree: (entries: readonly OverviewNode[]) => string;

  constructor(args: OverviewTextBudgetArgs) {
    this.maxChars = args.maxChars;
    this.renderTree = args.renderTree;
  }

  render(entries: readonly OverviewNode[]): string {
    const fullText = this.renderTree(entries);
    if (fullText.length <= this.maxChars) return fullText;

    const levels = OverviewTextBudget.levelsOf(entries);
    let shownText = this.textShowingLevels(entries, levels, NO_LEVELS_SHOWN);
    for (let fullLevels = 0; fullLevels < levels.length - 1; fullLevels++) {
      const text = this.textShowingLevels(entries, levels, fullLevels);
      if (text.length > this.maxChars) break;
      shownText = text;
    }
    return shownText;
  }

  private textShowingLevels(
    entries: readonly OverviewNode[],
    levels: readonly (readonly OverviewNode[])[],
    deepestLevel: number,
  ): string {
    const body = this.renderTree(OverviewTextBudget.trimmed(entries, deepestLevel));
    return body + this.footer(levels, deepestLevel);
  }

  private footer(levels: readonly (readonly OverviewNode[])[], deepestLevel: number): string {
    const deepestTreeLevel = levels.length - 1;
    const totalNodes = OverviewTextBudget.countUpTo(levels, deepestTreeLevel);
    const shownNodes = OverviewTextBudget.countUpTo(levels, deepestLevel);
    const omitted = `${totalNodes - shownNodes} nodes omitted`;
    const nothingShown = deepestLevel === NO_LEVELS_SHOWN;
    const shown = nothingShown
      ? omitted
      : `showing depth ${deepestLevel} of ${deepestTreeLevel}, ${omitted}`;
    const hints = nothingShown ? [ALL_HINT] : [AT_HINT, ALL_HINT];
    return `… cut to fit ${this.maxChars} chars: ${shown}\n… more: ${hints.join(", or ")}\n`;
  }

  private static countUpTo(levels: readonly (readonly OverviewNode[])[], level: number): number {
    return levels.slice(0, level + 1).reduce((count, nodes) => count + nodes.length, 0);
  }

  private static levelsOf(entries: readonly OverviewNode[]): readonly (readonly OverviewNode[])[] {
    const levels: (readonly OverviewNode[])[] = [];
    let level = entries;
    while (level.length > 0) {
      levels.push(level);
      level = level.flatMap((node) => OverviewTextBudget.childrenOf(node));
    }
    return levels;
  }

  private static trimmed(
    nodes: readonly OverviewNode[],
    remainingLevels: number,
  ): readonly OverviewNode[] {
    if (remainingLevels < 0) return [];
    return nodes.map((node) => {
      if (node.type === "re-export") return node;
      return { ...node, children: OverviewTextBudget.trimmed(node.children, remainingLevels - 1) };
    });
  }

  private static childrenOf(node: OverviewNode): readonly OverviewNode[] {
    if (node.type === "re-export") return [];
    return node.children;
  }
}
