import {
  Node,
  ts,
  type Identifier,
  type ImportDeclaration,
  type PropertyAccessExpression,
  type SourceFile,
  type StringLiteral,
} from "ts-morph";

import {
  JavaScriptAssignmentDeclarations,
  type CommonJsExportName,
  type JavaScriptAssignmentDeclaration,
  type JavaScriptAssignmentDeclarationForm,
} from "../extract/javascript-assignment-declaration.js";
import type { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

interface PendingExport {
  readonly sourceFile: SourceFile;
  readonly exported: CommonJsExportName;
}

interface ImporterAnchors {
  readonly bindings: readonly Identifier[];
  readonly members: readonly Node[];
  readonly memberBindings: readonly Identifier[];
  readonly reExportingFiles: readonly SourceFile[];
}

const NO_ANCHORS: ImporterAnchors = {
  bindings: [],
  members: [],
  memberBindings: [],
  reExportingFiles: [],
};

export class CommonJsExportImporters {
  private static readonly MEMBER_EXPORT_FORMS: ReadonlySet<JavaScriptAssignmentDeclarationForm> =
    new Set(["export-property", "module-exports-member", "define-property-export"]);

  private readonly importLiteralsByProgram = new WeakMap<
    ts.Program,
    ReadonlyMap<string, readonly StringLiteral[]>
  >();

  constructor(private readonly workspaceState: TypeScriptWorkspaceState) {}

  referencesThrough(declarationNode: Node, references: readonly Node[]): readonly Node[] {
    const found: Node[] = [];
    const listedLines = new Set(references.map(CommonJsExportImporters.lineKey));
    const visited = new Set<string>();
    const pending = [
      ...CommonJsExportImporters.ownExportOf(declarationNode),
      ...CommonJsExportImporters.exportsNamedBy(references),
    ];
    for (let next = pending.pop(); next; next = pending.pop()) {
      const key = CommonJsExportImporters.exportKey(next);
      if (visited.has(key)) continue;
      visited.add(key);
      for (const literal of this.importLiteralsOf(next.sourceFile)) {
        const anchors = CommonJsExportImporters.anchorsAt(literal, next.exported);
        for (const binding of anchors.bindings) {
          const bindingReferences = CommonJsExportImporters.otherReferencesInFileOf(binding);
          if (!listedLines.has(CommonJsExportImporters.lineKey(binding))) found.push(binding);
          found.push(...bindingReferences);
          pending.push(...CommonJsExportImporters.exportsNamedBy(bindingReferences));
        }
        for (const binding of anchors.memberBindings) {
          const bindingReferences = CommonJsExportImporters.otherReferencesInFileOf(binding);
          found.push(...bindingReferences);
          pending.push(...CommonJsExportImporters.exportsNamedBy(bindingReferences));
        }
        found.push(...anchors.members);
        for (const sourceFile of anchors.reExportingFiles) {
          pending.push({ sourceFile, exported: next.exported });
        }
        for (const node of found) listedLines.add(CommonJsExportImporters.lineKey(node));
      }
    }
    return found;
  }

  private static otherReferencesInFileOf(binding: Identifier): readonly Node[] {
    const sourceFile = binding.getSourceFile();
    return CommonJsExportImporters.referenceNodesOf(binding).filter(
      (reference) =>
        reference.getSourceFile() === sourceFile && reference.getStart() !== binding.getStart(),
    );
  }

  private static lineKey(node: Node): string {
    return `${node.getSourceFile().getFilePath()}:${node.getStartLineNumber()}`;
  }

  private static ownExportOf(declarationNode: Node): readonly PendingExport[] {
    const declaration = JavaScriptAssignmentDeclarations.declarationAt(declarationNode);
    const exported = declaration && CommonJsExportImporters.exportNameOf(declaration);
    return exported ? [{ sourceFile: declarationNode.getSourceFile(), exported }] : [];
  }

  private static exportNameOf(
    declaration: JavaScriptAssignmentDeclaration,
  ): CommonJsExportName | undefined {
    if (declaration.form === "module-exports") return { kind: "module" };
    if (!CommonJsExportImporters.MEMBER_EXPORT_FORMS.has(declaration.form)) return undefined;
    return { kind: "member", name: declaration.name };
  }

  private static exportsNamedBy(references: readonly Node[]): readonly PendingExport[] {
    return references.flatMap((reference) => {
      const exported = JavaScriptAssignmentDeclarations.commonJsExportNamedBy(reference);
      return exported ? [{ sourceFile: reference.getSourceFile(), exported }] : [];
    });
  }

  private importLiteralsOf(sourceFile: SourceFile): readonly StringLiteral[] {
    const project = sourceFile.getProject();
    const program = project.getProgram().compilerObject;
    let literalsByTarget = this.importLiteralsByProgram.get(program);
    if (!literalsByTarget) {
      literalsByTarget = this.scanImportLiterals(project.getSourceFiles());
      this.importLiteralsByProgram.set(program, literalsByTarget);
    }
    return literalsByTarget.get(sourceFile.getFilePath()) ?? [];
  }

  private scanImportLiterals(
    sourceFiles: readonly SourceFile[],
  ): ReadonlyMap<string, readonly StringLiteral[]> {
    const literalsByTarget = new Map<string, StringLiteral[]>();
    for (const importer of sourceFiles) {
      if (!this.workspaceState.relativePathOf(importer)) continue;
      for (const literal of importer.getImportStringLiterals()) {
        const target = literal
          .getSymbol()
          ?.getDeclarations()
          .find((declaration) => Node.isSourceFile(declaration))
          ?.getSourceFile()
          .getFilePath();
        if (!target) continue;
        const literals = literalsByTarget.get(target) ?? [];
        literals.push(literal);
        literalsByTarget.set(target, literals);
      }
    }
    return literalsByTarget;
  }

  private static anchorsAt(literal: StringLiteral, exported: CommonJsExportName): ImporterAnchors {
    const holder = literal.getParent();
    if (Node.isImportDeclaration(holder)) {
      return CommonJsExportImporters.importDeclarationAnchors(holder, exported);
    }
    if (Node.isExportDeclaration(holder)) {
      if (exported.kind !== "member") return NO_ANCHORS;
      const bindings = holder
        .getNamedExports()
        .filter((specifier) => specifier.getName() === exported.name)
        .map((specifier) => specifier.getAliasNode() ?? specifier.getNameNode())
        .filter(Node.isIdentifier);
      return { ...NO_ANCHORS, bindings };
    }
    if (Node.isExternalModuleReference(holder)) {
      const declaration = holder.getParent();
      if (!Node.isImportEqualsDeclaration(declaration)) return NO_ANCHORS;
      return CommonJsExportImporters.moduleBindingAnchors(declaration.getNameNode(), exported);
    }
    const isRequireCall = Node.isCallExpression(holder) && holder.getArguments()[0] === literal;
    if (!isRequireCall) return NO_ANCHORS;
    return CommonJsExportImporters.requireCallAnchors(holder, exported);
  }

  private static importDeclarationAnchors(
    declaration: ImportDeclaration,
    exported: CommonJsExportName,
  ): ImporterAnchors {
    const clause = declaration.getImportClause();
    if (!clause) return NO_ANCHORS;
    const defaultImport = clause.getDefaultImport();
    const moduleAnchors = defaultImport
      ? CommonJsExportImporters.moduleBindingAnchors(defaultImport, exported)
      : NO_ANCHORS;
    if (exported.kind === "module") return moduleAnchors;
    const namespaceImport = clause.getNamespaceImport();
    const namespaceAnchors = namespaceImport
      ? CommonJsExportImporters.memberAccessesOf(namespaceImport, exported.name)
      : NO_ANCHORS;
    const namedBindings = clause
      .getNamedImports()
      .filter((specifier) => specifier.getName() === exported.name)
      .map((specifier) => specifier.getAliasNode() ?? specifier.getNameNode())
      .filter(Node.isIdentifier);
    return CommonJsExportImporters.merged([
      moduleAnchors,
      namespaceAnchors,
      { ...NO_ANCHORS, bindings: namedBindings },
    ]);
  }

  private static requireCallAnchors(call: Node, exported: CommonJsExportName): ImporterAnchors {
    if (JavaScriptAssignmentDeclarations.reExportsModule(call)) {
      return { ...NO_ANCHORS, reExportingFiles: [call.getSourceFile()] };
    }
    const holder = call.getParent();
    if (Node.isPropertyAccessExpression(holder) && holder.getExpression() === call) {
      const accessesMember = exported.kind === "member" && holder.getName() === exported.name;
      return accessesMember ? CommonJsExportImporters.memberAccessAnchors(holder) : NO_ANCHORS;
    }
    const isInitializer = Node.isVariableDeclaration(holder) && holder.getInitializer() === call;
    if (!isInitializer) return NO_ANCHORS;
    const name = holder.getNameNode();
    if (Node.isIdentifier(name))
      return CommonJsExportImporters.moduleBindingAnchors(name, exported);
    if (!Node.isObjectBindingPattern(name) || exported.kind !== "member") return NO_ANCHORS;
    const bindings = name
      .getElements()
      .filter((element) => {
        const propertyName = element.getPropertyNameNode() ?? element.getNameNode();
        return Node.isIdentifier(propertyName) && propertyName.getText() === exported.name;
      })
      .map((element) => element.getNameNode())
      .filter(Node.isIdentifier);
    return { ...NO_ANCHORS, bindings };
  }

  private static moduleBindingAnchors(
    binding: Identifier,
    exported: CommonJsExportName,
  ): ImporterAnchors {
    if (exported.kind === "module") return { ...NO_ANCHORS, bindings: [binding] };
    return CommonJsExportImporters.memberAccessesOf(binding, exported.name);
  }

  private static memberAccessesOf(binding: Identifier, name: string): ImporterAnchors {
    const anchors = CommonJsExportImporters.referenceNodesOf(binding).flatMap((reference) => {
      if (JavaScriptAssignmentDeclarations.reExportsModule(reference)) {
        return [{ ...NO_ANCHORS, reExportingFiles: [reference.getSourceFile()] }];
      }
      const access = reference.getParent();
      const accessesMember =
        Node.isPropertyAccessExpression(access) &&
        access.getExpression() === reference &&
        access.getName() === name;
      return accessesMember ? [CommonJsExportImporters.memberAccessAnchors(access)] : [];
    });
    return CommonJsExportImporters.merged(anchors);
  }

  private static memberAccessAnchors(access: PropertyAccessExpression): ImporterAnchors {
    const holder = access.getParent();
    const initializedName =
      Node.isVariableDeclaration(holder) && holder.getInitializer() === access
        ? holder.getNameNode()
        : undefined;
    return {
      ...NO_ANCHORS,
      members: [access.getNameNode()],
      memberBindings: Node.isIdentifier(initializedName) ? [initializedName] : [],
    };
  }

  private static merged(anchors: readonly ImporterAnchors[]): ImporterAnchors {
    return {
      bindings: anchors.flatMap((anchor) => anchor.bindings),
      members: anchors.flatMap((anchor) => anchor.members),
      memberBindings: anchors.flatMap((anchor) => anchor.memberBindings),
      reExportingFiles: anchors.flatMap((anchor) => anchor.reExportingFiles),
    };
  }

  private static referenceNodesOf(binding: Identifier): readonly Node[] {
    return binding
      .findReferences()
      .flatMap((referencedSymbol) => referencedSymbol.getReferences())
      .map((entry) => entry.getNode());
  }

  private static exportKey({ sourceFile, exported }: PendingExport): string {
    const name = exported.kind === "member" ? `member:${exported.name}` : "module";
    return `${sourceFile.getFilePath()}\0${name}`;
  }
}
