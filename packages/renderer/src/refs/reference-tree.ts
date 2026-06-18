import type { SymbolReference } from "@symnav/core";

export interface ReferenceTreeDirectory {
  readonly label: string;
  readonly children: readonly ReferenceTreeNode[];
}

export interface ReferenceTreeFile {
  readonly label: string;
  readonly references: readonly SymbolReference[];
}

export type ReferenceTreeNode = ReferenceTreeDirectory | ReferenceTreeFile;

export function buildReferenceTree(
  references: readonly SymbolReference[],
): readonly ReferenceTreeNode[] {
  const root = newTrieDirectory();
  for (const reference of references) {
    insertReference(root, reference);
  }
  return [...root.entries.entries()].map(([name, entry]) => toNode(name, entry));
}

interface TrieDirectory {
  readonly entries: Map<string, TrieEntry>;
}

interface TrieFile {
  readonly references: SymbolReference[];
}

type TrieEntry = TrieDirectory | TrieFile;

function newTrieDirectory(): TrieDirectory {
  return { entries: new Map() };
}

function isTrieDirectory(entry: TrieEntry): entry is TrieDirectory {
  return "entries" in entry;
}

function insertReference(root: TrieDirectory, reference: SymbolReference): void {
  let directory = root;
  let remainder = reference.file;
  let slashIndex = remainder.indexOf("/");
  while (slashIndex !== -1) {
    directory = childDirectory(directory, remainder.slice(0, slashIndex));
    remainder = remainder.slice(slashIndex + 1);
    slashIndex = remainder.indexOf("/");
  }
  childFile(directory, remainder).references.push(reference);
}

function childDirectory(parent: TrieDirectory, name: string): TrieDirectory {
  const existing = parent.entries.get(name);
  if (existing !== undefined && isTrieDirectory(existing)) {
    return existing;
  }
  const created = newTrieDirectory();
  parent.entries.set(name, created);
  return created;
}

function childFile(parent: TrieDirectory, name: string): TrieFile {
  const existing = parent.entries.get(name);
  if (existing !== undefined && !isTrieDirectory(existing)) {
    return existing;
  }
  const created: TrieFile = { references: [] };
  parent.entries.set(name, created);
  return created;
}

function toNode(name: string, entry: TrieEntry): ReferenceTreeNode {
  if (!isTrieDirectory(entry)) {
    return { label: name, references: entry.references };
  }
  const children = [...entry.entries.entries()].map(([childName, child]) =>
    toNode(childName, child),
  );
  const label = `${name}/`;
  const [onlyChild, ...rest] = children;
  if (onlyChild !== undefined && rest.length === 0) {
    return collapseInto(label, onlyChild);
  }
  return { label, children };
}

function collapseInto(directoryLabel: string, child: ReferenceTreeNode): ReferenceTreeNode {
  if ("references" in child) {
    return { label: directoryLabel + child.label, references: child.references };
  }
  return { label: directoryLabel + child.label, children: child.children };
}
