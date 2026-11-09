import type { OverviewNode } from "@symnav/core";

export interface OverviewTextBudgetArgs {
  readonly maxChars: number;
  readonly renderTree: (entries: readonly OverviewNode[]) => string;
}

type OverviewLevels = readonly (readonly OverviewNode[])[];

interface OverviewCut {
  readonly fullLevels: number;
  readonly cutLevelShownCount: number;
}

const NO_LEVELS_SHOWN = -1;
const MIN_CUT_PARENTS_WORTH_DRILLING_INTO = 2;
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
    const fullLevels = this.deepestFittingFullLevel(entries, levels);
    const cutLevelShownCount = this.mostFittingCutLevelNodes(entries, levels, fullLevels);
    return this.textFor(entries, levels, { fullLevels, cutLevelShownCount });
  }

  private deepestFittingFullLevel(
    entries: readonly OverviewNode[],
    levels: OverviewLevels,
  ): number {
    let fullLevels = NO_LEVELS_SHOWN;
    while (fullLevels + 1 < levels.length - 1) {
      const deeper: OverviewCut = { fullLevels: fullLevels + 1, cutLevelShownCount: 0 };
      if (!this.fits(entries, levels, deeper)) break;
      fullLevels = deeper.fullLevels;
    }
    return fullLevels;
  }

  private mostFittingCutLevelNodes(
    entries: readonly OverviewNode[],
    levels: OverviewLevels,
    fullLevels: number,
  ): number {
    const cutLevelSize = levels[fullLevels + 1]?.length ?? 0;
    let fitting = 0;
    let overflowing = cutLevelSize;
    while (overflowing - fitting > 1) {
      const middle = Math.floor((fitting + overflowing) / 2);
      if (this.fits(entries, levels, { fullLevels, cutLevelShownCount: middle })) {
        fitting = middle;
      } else {
        overflowing = middle;
      }
    }
    return this.mostFittingAbove(entries, levels, { fullLevels, cutLevelShownCount: fitting });
  }

  private mostFittingAbove(
    entries: readonly OverviewNode[],
    levels: OverviewLevels,
    fitting: OverviewCut,
  ): number {
    const cutLevelSize = levels[fitting.fullLevels + 1]?.length ?? 0;
    let best = fitting.cutLevelShownCount;
    for (let count = best + 1; count < cutLevelSize; count++) {
      const cut: OverviewCut = { fullLevels: fitting.fullLevels, cutLevelShownCount: count };
      if (this.bodyFor(entries, levels, cut).length > this.maxChars) break;
      if (this.fits(entries, levels, cut)) best = count;
    }
    return best;
  }

  private fits(
    entries: readonly OverviewNode[],
    levels: OverviewLevels,
    cut: OverviewCut,
  ): boolean {
    return this.textFor(entries, levels, cut).length <= this.maxChars;
  }

  private textFor(
    entries: readonly OverviewNode[],
    levels: OverviewLevels,
    cut: OverviewCut,
  ): string {
    return this.bodyFor(entries, levels, cut) + this.footerFor(levels, cut);
  }

  private bodyFor(
    entries: readonly OverviewNode[],
    levels: OverviewLevels,
    cut: OverviewCut,
  ): string {
    const shown = OverviewTextBudget.shownCutNodes(levels, cut);
    return this.renderTree(OverviewTextBudget.pruned(entries, 0, cut, shown));
  }

  private footerFor(levels: OverviewLevels, cut: OverviewCut): string {
    const footerLines = [
      this.summaryLine(levels, cut),
      OverviewTextBudget.omittedSpanLine(cut, levels[cut.fullLevels + 1] ?? []),
      OverviewTextBudget.moreLine(levels, cut),
    ];
    return footerLines
      .filter((line) => line !== undefined)
      .map((line) => `${line}\n`)
      .join("");
  }

  private summaryLine(levels: OverviewLevels, cut: OverviewCut): string {
    const deepestTreeLevel = levels.length - 1;
    const shownParts: string[] = [];
    if (cut.fullLevels !== NO_LEVELS_SHOWN) {
      shownParts.push(`depth ${cut.fullLevels} of ${deepestTreeLevel}`);
    }
    const lastShownCutNode = levels[cut.fullLevels + 1]?.[cut.cutLevelShownCount - 1];
    if (lastShownCutNode !== undefined) {
      shownParts.push(`depth ${cut.fullLevels + 1} through line ${lastShownCutNode.range.endLine}`);
    }
    const totalNodes = OverviewTextBudget.countUpTo(levels, deepestTreeLevel);
    const shownNodes =
      OverviewTextBudget.countUpTo(levels, cut.fullLevels) + cut.cutLevelShownCount;
    const omitted = `${totalNodes - shownNodes} nodes omitted`;
    const summary =
      shownParts.length === 0 ? omitted : `showing ${shownParts.join(", ")}, ${omitted}`;
    return `… cut to fit ${this.maxChars} chars: ${summary}`;
  }

  private static omittedSpanLine(
    cut: OverviewCut,
    cutLevelNodes: readonly OverviewNode[],
  ): string | undefined {
    const firstOmitted = cutLevelNodes[cut.cutLevelShownCount];
    const lastOmitted = cutLevelNodes.at(-1);
    const cutLevelIsPartlyShown = cut.cutLevelShownCount > 0 && firstOmitted !== undefined;
    if (!cutLevelIsPartlyShown || lastOmitted === undefined) return undefined;
    const span = `${firstOmitted.range.startLine}-${lastOmitted.range.endLine}`;
    return `… omitted at depth ${cut.fullLevels + 1}: lines ${span}`;
  }

  private static moreLine(levels: OverviewLevels, cut: OverviewCut): string {
    const hints = OverviewTextBudget.offersDrillIn(levels, cut) ? [AT_HINT, ALL_HINT] : [ALL_HINT];
    return `… more: ${hints.join(", or ")}`;
  }

  private static offersDrillIn(levels: OverviewLevels, cut: OverviewCut): boolean {
    const shown = OverviewTextBudget.shownCutNodes(levels, cut);
    const someShownCutNodeHasChildren = [...shown].some(
      (node) => OverviewTextBudget.childrenOf(node).length > 0,
    );
    const parentsWithOmittedChildren = (levels[cut.fullLevels] ?? []).filter((node) =>
      OverviewTextBudget.childrenOf(node).some((child) => !shown.has(child)),
    );
    const drillingIntoAParentGivesANewView =
      parentsWithOmittedChildren.length >= MIN_CUT_PARENTS_WORTH_DRILLING_INTO;
    return someShownCutNodeHasChildren || drillingIntoAParentGivesANewView;
  }

  private static shownCutNodes(
    levels: OverviewLevels,
    cut: OverviewCut,
  ): ReadonlySet<OverviewNode> {
    return new Set(levels[cut.fullLevels + 1]?.slice(0, cut.cutLevelShownCount) ?? []);
  }

  private static countUpTo(levels: OverviewLevels, level: number): number {
    return levels.slice(0, level + 1).reduce((count, nodes) => count + nodes.length, 0);
  }

  private static levelsOf(entries: readonly OverviewNode[]): OverviewLevels {
    const levels: (readonly OverviewNode[])[] = [];
    let level = entries;
    while (level.length > 0) {
      levels.push(level);
      level = level.flatMap((node) => OverviewTextBudget.childrenOf(node));
    }
    return levels;
  }

  private static pruned(
    nodes: readonly OverviewNode[],
    level: number,
    cut: OverviewCut,
    shownCutNodes: ReadonlySet<OverviewNode>,
  ): readonly OverviewNode[] {
    return nodes
      .filter((node) => level <= cut.fullLevels || shownCutNodes.has(node))
      .map((node) => {
        if (node.type === "re-export") return node;
        if (level > cut.fullLevels) return { ...node, children: [] };
        return {
          ...node,
          children: OverviewTextBudget.pruned(node.children, level + 1, cut, shownCutNodes),
        };
      });
  }

  private static childrenOf(node: OverviewNode): readonly OverviewNode[] {
    if (node.type === "re-export") return [];
    return node.children;
  }
}
