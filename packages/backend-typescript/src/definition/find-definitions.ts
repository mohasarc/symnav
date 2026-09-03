import {
  Node,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type ModuleDeclaration,
  type SourceFile,
} from "ts-morph";
import type { ResolvedPath, SymbolOverviewNode, SymbolIdentity } from "@symnav/core";

import { DeclarationLocator, type LocatedDeclaration } from "../identity/locate-declarations.js";
import type { TypeScriptWorkspaceState } from "../typescript-backend/typescript-workspace-state.js";

export interface FindDefinitionsArgs {
  readonly workspaceState: TypeScriptWorkspaceState;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findDefinitions(
  args: FindDefinitionsArgs,
): Promise<readonly SymbolOverviewNode[]> {
  await args.workspaceState.ensureFiles(args.files);
  return new DefinitionFinder(args).find();
}

class DefinitionFinder {
  private readonly workspaceState: TypeScriptWorkspaceState;

  constructor(private readonly args: FindDefinitionsArgs) {
    this.workspaceState = args.workspaceState;
  }

  async find(): Promise<readonly SymbolOverviewNode[]> {
    const matches = this.workspaceState.locate(this.args.identity);
    return this.withContractImplementations(matches);
  }

  private withContractImplementations(
    matches: readonly LocatedDeclaration[],
  ): SymbolOverviewNode[] {
    const seen = new Set<string>();
    const out: SymbolOverviewNode[] = [];
    for (const match of matches) {
      addUniqueDeclaration(out, seen, match.declaration);
      if (!isContract(match.node)) continue;
      for (const implementation of this.implementationsOf(match.node)) {
        addUniqueDeclaration(out, seen, implementation);
      }
    }
    return out;
  }

  private implementationsOf(node: Node): SymbolOverviewNode[] {
    if (!Node.isMethodSignature(node) && !Node.isMethodDeclaration(node)) return [];
    const nameNode = node.getNameNode();
    if (!Node.isIdentifier(nameNode)) return [];
    const out: SymbolOverviewNode[] = [];
    for (const location of nameNode.getImplementations()) {
      const owner = enclosingMethod(location.getNode());
      if (!owner || owner === node) continue;
      const declaration = this.indexedDeclarationFor(owner);
      if (declaration) out.push(declaration);
    }
    return out;
  }

  private indexedDeclarationFor(
    methodNode: MethodDeclaration | MethodSignature,
  ): SymbolOverviewNode | undefined {
    const filePath = this.workspaceRelativePathOf(methodNode.getSourceFile());
    if (!filePath) return undefined;
    const segments = [...enclosingTypeNames(methodNode), methodNode.getName()].map((name) => ({
      name,
    }));
    return this.workspaceState.declarationForIdentity({ file: filePath, segments })?.declaration;
  }

  private workspaceRelativePathOf(sourceFile: SourceFile): string | undefined {
    return this.workspaceState.relativePathOf(sourceFile);
  }
}

function addUniqueDeclaration(
  out: SymbolOverviewNode[],
  seen: Set<string>,
  declaration: SymbolOverviewNode,
): void {
  const key = DeclarationLocator.identityKey(declaration.identity);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(declaration);
}

function isContract(node: Node): boolean {
  if (Node.isMethodSignature(node)) return true;
  if (Node.isMethodDeclaration(node) && node.isAbstract()) return true;
  return false;
}

function enclosingMethod(node: Node): MethodDeclaration | MethodSignature | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isMethodDeclaration(current) || Node.isMethodSignature(current)) {
      return current;
    }
    current = current.getParent();
  }
  return undefined;
}

function enclosingTypeNames(node: Node): string[] {
  const out: string[] = [];
  let current: Node | undefined = node.getParent();
  while (current) {
    if (isContainer(current)) {
      const name = (
        current as ClassDeclaration | InterfaceDeclaration | ModuleDeclaration
      ).getName();
      if (name) out.unshift(name);
    }
    current = current.getParent();
  }
  return out;
}

function isContainer(
  node: Node,
): node is ClassDeclaration | InterfaceDeclaration | ModuleDeclaration {
  return (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isModuleDeclaration(node)
  );
}
