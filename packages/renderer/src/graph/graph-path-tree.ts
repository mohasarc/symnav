import type { GraphPath, GraphPathStep } from "@symnav/core";
import { formatSymbolIdentity } from "@symnav/core";

export interface GraphPathTreeNode {
  readonly step: GraphPathStep;
  readonly children: readonly GraphPathTreeNode[];
}

export function buildGraphPathTree(paths: readonly GraphPath[]): readonly GraphPathTreeNode[] {
  const roots = new PathTreeChildren();
  for (const path of paths) {
    roots.insert(path.steps);
  }
  return roots.nodes();
}

class PathTreeChildren {
  private readonly nodesByKey = new Map<string, MutableGraphPathTreeNode>();

  insert(steps: readonly GraphPathStep[]): void {
    const [step, ...remainingSteps] = steps;
    if (step === undefined) {
      return;
    }
    const node = this.nodeFor(step);
    if (step.closesCycle) {
      return;
    }
    node.children.insert(remainingSteps);
  }

  nodes(): readonly GraphPathTreeNode[] {
    return [...this.nodesByKey.values()].map((node) => node.toNode());
  }

  private nodeFor(step: GraphPathStep): MutableGraphPathTreeNode {
    const key = graphPathStepKey(step);
    const existing = this.nodesByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = new MutableGraphPathTreeNode(step);
    this.nodesByKey.set(key, created);
    return created;
  }
}

class MutableGraphPathTreeNode {
  readonly children = new PathTreeChildren();

  constructor(private readonly step: GraphPathStep) {}

  toNode(): GraphPathTreeNode {
    return {
      step: this.step,
      children: this.children.nodes(),
    };
  }
}

function graphPathStepKey(step: GraphPathStep): string {
  return `${formatSymbolIdentity(step.symbol.identity)}\0${step.confidence}`;
}
