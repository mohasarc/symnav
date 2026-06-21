import type { SymbolReference } from "@symnav/core";

interface ReferenceTreeNodeBase {
  readonly subpath: string;
}

export interface ReferenceTreeDirectory extends ReferenceTreeNodeBase {
  readonly children: readonly ReferenceTreeNode[];
}

export interface ReferenceTreeFile extends ReferenceTreeNodeBase {
  readonly references: readonly SymbolReference[];
}

export type ReferenceTreeNode = ReferenceTreeDirectory | ReferenceTreeFile;

export function buildReferenceTree(
  references: readonly SymbolReference[],
): readonly ReferenceTreeNode[] {
  const root = new TrieDirectory();
  for (const reference of references) {
    root.insert(reference);
  }
  return root.toNodes();
}

type TrieEntry = TrieDirectory | TrieFile;

class TrieFile {
  readonly references: SymbolReference[] = [];

  toNode(name: string): ReferenceTreeFile {
    return { subpath: name, references: this.references };
  }
}

class TrieDirectory {
  private readonly entries = new Map<string, TrieEntry>();

  insert(reference: SymbolReference): void {
    let directory: TrieDirectory = this;
    let remainder = reference.file;
    let slashIndex = remainder.indexOf("/");
    while (slashIndex !== -1) {
      directory = directory.childDirectory(remainder.slice(0, slashIndex));
      remainder = remainder.slice(slashIndex + 1);
      slashIndex = remainder.indexOf("/");
    }
    directory.childFile(remainder).references.push(reference);
  }

  toNodes(): readonly ReferenceTreeNode[] {
    return [...this.entries.entries()].map(([name, entry]) => entry.toNode(name));
  }

  toNode(name: string): ReferenceTreeNode {
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

function collapseInto(directorySubpath: string, child: ReferenceTreeNode): ReferenceTreeNode {
  if ("references" in child) {
    return { subpath: directorySubpath + child.subpath, references: child.references };
  }
  return { subpath: directorySubpath + child.subpath, children: child.children };
}
