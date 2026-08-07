import {
  Node,
  SyntaxKind,
  type Block,
  type ExpressionStatement,
  type TryStatement,
  type VariableDeclaration,
  type VariableStatement,
} from "ts-morph";
import {
  splitHeaderLines,
  type DiagnosticSink,
  type FoldOverviewNode,
  type LineRange,
  type OverviewNode,
  type Header,
  type SymbolIdentity,
  type SymbolOverviewNode,
  type SymbolPathSegment,
} from "@symnav/core";

import { reportUnrecognisedNode } from "./extraction-diagnostics.js";
import { FoldHeaderExtractor } from "./extract-fold-header.js";
import { FoldHeaderVariantsExtractor } from "./extract-fold-header-variants.js";
import { ReExportEntryExtractor } from "./extract-re-export-entry.js";
import { extractSignatureSource } from "./extract-signature-source.js";
import { extractVariableSignature } from "./extract-variable-signature.js";
import { FoldNodeKind, type TypeScriptFoldKind } from "./fold-node-kind.js";
import { nodeKind } from "./node-kind.js";
import { refineLabel } from "./refine-label.js";
import { statementCallExpression, trailingCallbackBody } from "./trailing-callback.js";
import { roleOf } from "./typescript-symbol-kind.js";

export class OverviewChildrenExtractor {
  private static readonly IGNORED_STATEMENT_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.ImportDeclaration,
    SyntaxKind.NamespaceExportDeclaration,
    SyntaxKind.ImportEqualsDeclaration,
    SyntaxKind.EmptyStatement,
    SyntaxKind.ExpressionStatement,
    SyntaxKind.ThrowStatement,
    SyntaxKind.ReturnStatement,
    SyntaxKind.BreakStatement,
    SyntaxKind.ContinueStatement,
    SyntaxKind.LabeledStatement,
    SyntaxKind.DebuggerStatement,
    SyntaxKind.WithStatement,
  ]);

  private static readonly IGNORED_MEMBER_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.ClassStaticBlockDeclaration,
    SyntaxKind.SemicolonClassElement,
  ]);

  private readonly file: string;
  private readonly diagnostics: DiagnosticSink | undefined;

  constructor(args: { file: string; diagnostics?: DiagnosticSink | undefined }) {
    this.file = args.file;
    this.diagnostics = args.diagnostics;
  }

  extract(nodes: readonly Node[]): readonly OverviewNode[] {
    return this.extractNodes({ nodes, symbolSegments: [], category: "statement" });
  }

  private extractNodes(args: {
    nodes: readonly Node[];
    symbolSegments: readonly SymbolPathSegment[];
    category: "statement" | "member";
  }): readonly OverviewNode[] {
    return args.nodes.flatMap((node) =>
      this.toOverviewNode({ node, symbolSegments: args.symbolSegments, category: args.category }),
    );
  }

  private toOverviewNode(args: {
    node: Node;
    symbolSegments: readonly SymbolPathSegment[];
    category: "statement" | "member";
  }): readonly OverviewNode[] {
    const { node, symbolSegments, category } = args;
    const kind = nodeKind(node);
    if (kind) return this.toSymbolNodes(node, kind, symbolSegments);

    const foldKind = FoldNodeKind.of(node);
    if (foldKind) return this.toFoldNodes(node, foldKind, symbolSegments);

    const reExport = ReExportEntryExtractor.extract(node);
    if (reExport) return [reExport];

    if (OverviewChildrenExtractor.isIgnoredNode(node)) return [];
    if (!this.diagnostics) return [];
    reportUnrecognisedNode({
      sink: this.diagnostics,
      node,
      filePath: this.file,
      category,
    });
    return [];
  }

  private toSymbolNodes(
    node: Node,
    kind: NonNullable<ReturnType<typeof nodeKind>>,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly SymbolOverviewNode[] {
    if (Node.isVariableStatement(node)) {
      return this.expandVariableStatement(node, symbolSegments);
    }
    if (OverviewChildrenExtractor.isMemberNode(node)) {
      return OverviewChildrenExtractor.expandOverloads(node).map((member) =>
        this.buildSymbolNode({ node: member, kind, symbolSegments }),
      );
    }
    return [this.buildSymbolNode({ node, kind, symbolSegments })];
  }

  private buildSymbolNode(args: {
    node: Node;
    kind: NonNullable<ReturnType<typeof nodeKind>>;
    symbolSegments: readonly SymbolPathSegment[];
  }): SymbolOverviewNode {
    const { node, kind, symbolSegments } = args;
    const range = OverviewChildrenExtractor.nodeRange(node);
    const name = OverviewChildrenExtractor.nodeName(node);
    const refined = refineLabel(node, kind);
    const childSegments = [...symbolSegments, { name }];
    return {
      type: "symbol",
      identity: this.identityFor(childSegments),
      kind: { role: roleOf(refined), nativeLabel: refined },
      range,
      header: OverviewChildrenExtractor.headerFrom(range.startLine, extractSignatureSource(node)),
      children: this.symbolChildren(node, childSegments),
    };
  }

  private symbolChildren(
    node: Node,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly OverviewNode[] {
    if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
      return this.extractNodes({ nodes: node.getMembers(), symbolSegments, category: "member" });
    }
    if (Node.isModuleDeclaration(node)) {
      return this.extractNodes({
        nodes: node.getStatements(),
        symbolSegments,
        category: "statement",
      });
    }
    if (Node.isExportAssignment(node)) {
      return this.functionValueChildren(node.getExpression(), symbolSegments);
    }
    const body = OverviewChildrenExtractor.functionBodyOf(node);
    if (!body) return [];
    return this.extractNodes({
      nodes: body.getStatements(),
      symbolSegments,
      category: "statement",
    });
  }

  private toFoldNodes(
    node: Node,
    foldKind: TypeScriptFoldKind,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly FoldOverviewNode[] {
    if (Node.isTryStatement(node)) {
      return this.tryFoldNodes(node, symbolSegments);
    }
    const fold: FoldOverviewNode = {
      type: "fold",
      foldKind,
      range: OverviewChildrenExtractor.nodeRange(node),
      header: FoldHeaderExtractor.extract(node),
      children: this.foldChildren(node, symbolSegments),
    };
    const headerVariants = FoldHeaderVariantsExtractor.extract(node);
    if (headerVariants.length === 0) return [fold];
    return [{ ...fold, headerVariants }];
  }

  private tryFoldNodes(
    node: TryStatement,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly FoldOverviewNode[] {
    const nodes: FoldOverviewNode[] = [
      {
        type: "fold",
        foldKind: "try",
        range: OverviewChildrenExtractor.nodeRange(node.getTryBlock()),
        header: FoldHeaderExtractor.extract(node),
        children: this.extractNodes({
          nodes: node.getTryBlock().getStatements(),
          symbolSegments,
          category: "statement",
        }),
      },
    ];
    const catchClause = node.getCatchClause();
    if (catchClause) {
      nodes.push({
        type: "fold",
        foldKind: "catch",
        range: OverviewChildrenExtractor.nodeRange(catchClause),
        header: FoldHeaderExtractor.extract(catchClause),
        children: this.extractNodes({
          nodes: catchClause.getBlock().getStatements(),
          symbolSegments,
          category: "statement",
        }),
      });
    }
    const finallyBlock = node.getFinallyBlock();
    if (finallyBlock) {
      nodes.push({
        type: "fold",
        foldKind: "finally",
        range: OverviewChildrenExtractor.nodeRange(finallyBlock),
        header: { startLine: finallyBlock.getStartLineNumber(), lines: ["finally {"] },
        children: this.extractNodes({
          nodes: finallyBlock.getStatements(),
          symbolSegments,
          category: "statement",
        }),
      });
    }
    return nodes;
  }

  private foldChildren(
    node: Node,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly OverviewNode[] {
    if (Node.isExpressionStatement(node)) {
      const body = OverviewChildrenExtractor.trailingCallBody(node);
      return body
        ? this.extractNodes({ nodes: body.getStatements(), symbolSegments, category: "statement" })
        : [];
    }
    if (Node.isBlock(node)) {
      return this.extractNodes({
        nodes: node.getStatements(),
        symbolSegments,
        category: "statement",
      });
    }
    if (Node.isIfStatement(node)) {
      return this.extractStatementChildren(node.getThenStatement(), symbolSegments);
    }
    if (
      Node.isForStatement(node) ||
      Node.isForInStatement(node) ||
      Node.isForOfStatement(node) ||
      Node.isWhileStatement(node) ||
      Node.isDoStatement(node)
    ) {
      return this.extractStatementChildren(node.getStatement(), symbolSegments);
    }
    if (Node.isSwitchStatement(node)) {
      return this.extractNodes({
        nodes: node.getCaseBlock().getClauses(),
        symbolSegments,
        category: "statement",
      });
    }
    if (Node.isCaseClause(node) || Node.isDefaultClause(node)) {
      return node.getStatements().flatMap((statement) =>
        Node.isBlock(statement)
          ? this.extractNodes({
              nodes: statement.getStatements(),
              symbolSegments,
              category: "statement",
            })
          : this.toOverviewNode({ node: statement, symbolSegments, category: "statement" }),
      );
    }
    return [];
  }

  private extractStatementChildren(
    statement: Node,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly OverviewNode[] {
    if (Node.isBlock(statement)) {
      return this.extractNodes({
        nodes: statement.getStatements(),
        symbolSegments,
        category: "statement",
      });
    }
    return this.toOverviewNode({ node: statement, symbolSegments, category: "statement" });
  }

  private expandVariableStatement(
    statement: VariableStatement,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly SymbolOverviewNode[] {
    const declList = statement.getDeclarationList();
    const range = OverviewChildrenExtractor.nodeRange(statement);
    return declList.getDeclarations().map((decl) => {
      const childSegments = [...symbolSegments, { name: decl.getName() }];
      return {
        type: "symbol",
        identity: this.identityFor(childSegments),
        kind: { role: roleOf("variable"), nativeLabel: "variable" },
        range,
        header: OverviewChildrenExtractor.headerFrom(
          range.startLine,
          extractVariableSignature({ statement, declaration: decl }),
        ),
        children: this.variableInitializerChildren(decl, childSegments),
      };
    });
  }

  private variableInitializerChildren(
    declaration: VariableDeclaration,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly OverviewNode[] {
    const initializer = declaration.getInitializer();
    if (!initializer) return [];
    return this.functionValueChildren(initializer, symbolSegments);
  }

  private functionValueChildren(
    expression: Node,
    symbolSegments: readonly SymbolPathSegment[],
  ): readonly OverviewNode[] {
    const body = OverviewChildrenExtractor.functionValueBody(expression);
    if (!body) return [];
    return this.extractNodes({
      nodes: body.getStatements(),
      symbolSegments,
      category: "statement",
    });
  }

  private identityFor(symbolSegments: readonly SymbolPathSegment[]): SymbolIdentity {
    return {
      file: this.file,
      segments: symbolSegments,
    };
  }

  private static functionValueBody(expression: Node): Block | undefined {
    if (Node.isParenthesizedExpression(expression)) {
      return OverviewChildrenExtractor.functionValueBody(expression.getExpression());
    }
    if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
      const body = expression.getBody();
      return Node.isBlock(body) ? body : undefined;
    }
    return undefined;
  }

  private static expandOverloads(node: Node): Node[] {
    if (Node.isOverloadable(node) && node.isImplementation()) {
      const overloads = node.getOverloads();
      if (overloads.length > 0) {
        return [...overloads, node];
      }
    }
    return [node];
  }

  private static functionBodyOf(node: Node): Block | undefined {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isFunctionExpression(node)
    ) {
      const body = node.getBody();
      return body && Node.isBlock(body) ? body : undefined;
    }
    return undefined;
  }

  private static trailingCallBody(node: ExpressionStatement): Block | undefined {
    const call = statementCallExpression(node);
    if (!call) return undefined;
    return trailingCallbackBody(call);
  }

  private static headerFrom(startLine: number, raw: string): Header {
    return { startLine, lines: splitHeaderLines(raw) };
  }

  private static nodeName(node: Node): string {
    if (Node.isConstructorDeclaration(node)) return "constructor";
    if (Node.isCallSignatureDeclaration(node)) return "()";
    if (Node.isConstructSignatureDeclaration(node)) return "new()";
    if (Node.isIndexSignatureDeclaration(node)) return "[index]";
    if (Node.isExportAssignment(node)) return "default";

    if (
      Node.isFunctionDeclaration(node) ||
      Node.isClassDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      Node.isTypeAliasDeclaration(node) ||
      Node.isEnumDeclaration(node) ||
      Node.isModuleDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isPropertyDeclaration(node) ||
      Node.isMethodSignature(node) ||
      Node.isPropertySignature(node)
    ) {
      return node.getName() ?? "";
    }

    return "";
  }

  private static nodeRange(node: Node): LineRange {
    return {
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
    };
  }

  private static isMemberNode(node: Node): boolean {
    const parent = node.getParent();
    return (
      !!parent &&
      (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent)) &&
      !Node.isClassDeclaration(node) &&
      !Node.isInterfaceDeclaration(node)
    );
  }

  private static isIgnoredNode(node: Node): boolean {
    if (OverviewChildrenExtractor.IGNORED_STATEMENT_KINDS.has(node.getKind())) return true;
    if (OverviewChildrenExtractor.IGNORED_MEMBER_KINDS.has(node.getKind())) return true;
    return false;
  }
}
