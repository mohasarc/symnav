import type { CallEdge } from "@symnav/core";

interface CallEdgeTreeNodeBase {
  readonly subpath: string;
}

export interface CallEdgeTreeDirectory extends CallEdgeTreeNodeBase {
  readonly children: readonly CallEdgeTreeNode[];
}

export interface CallEdgeTreeFile extends CallEdgeTreeNodeBase {
  readonly edges: readonly CallEdge[];
}

export type CallEdgeTreeNode = CallEdgeTreeDirectory | CallEdgeTreeFile;

export function buildCallEdgeTree(edges: readonly CallEdge[]): readonly CallEdgeTreeNode[] {
  const root = new TrieDirectory();
  for (const edge of edges) {
    root.insert(edge);
  }
  return root.toNodes();
}

type TrieEntry = TrieDirectory | TrieFile;

class TrieFile {
  readonly edges: CallEdge[] = [];

  toNode(name: string): CallEdgeTreeFile {
    return { subpath: name, edges: this.edges };
  }
}

class TrieDirectory {
  private readonly entries = new Map<string, TrieEntry>();

  insert(edge: CallEdge): void {
    let directory: TrieDirectory = this;
    let remainder = edge.symbol.identity.file;
    let slashIndex = remainder.indexOf("/");
    while (slashIndex !== -1) {
      directory = directory.childDirectory(remainder.slice(0, slashIndex));
      remainder = remainder.slice(slashIndex + 1);
      slashIndex = remainder.indexOf("/");
    }
    directory.childFile(remainder).edges.push(edge);
  }

  toNodes(): readonly CallEdgeTreeNode[] {
    return [...this.entries.entries()].map(([name, entry]) => entry.toNode(name));
  }

  toNode(name: string): CallEdgeTreeNode {
    const children = this.toNodes();
    const subpath = `${name}/`;
    const [onlyChild, ...rest] = children;
    if (onlyChild !== undefined && rest.length === 0) {
      return collapseInto(subpath, onlyChild);
    }
    return { subpath, children };
  }

  private childDirectory(name: string): TrieDirectory {
    const existing = this.entries.get(name);
    if (existing instanceof TrieDirectory) {
      return existing;
    }
    const created = new TrieDirectory();
    this.entries.set(name, created);
    return created;
  }

  private childFile(name: string): TrieFile {
    const existing = this.entries.get(name);
    if (existing instanceof TrieFile) {
      return existing;
    }
    const created = new TrieFile();
    this.entries.set(name, created);
    return created;
  }
}

function collapseInto(directorySubpath: string, child: CallEdgeTreeNode): CallEdgeTreeNode {
  if ("edges" in child) {
    return { subpath: directorySubpath + child.subpath, edges: child.edges };
  }
  return { subpath: directorySubpath + child.subpath, children: child.children };
}
