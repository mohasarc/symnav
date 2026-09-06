import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

interface PathBuilderAliases {
  readonly functions: ReadonlySet<ts.Symbol>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
}

class ExternalDaemonStorageAccessInventory {
  private static readonly repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  static violations(): readonly string[] {
    return ExternalDaemonStorageAccessInventory.externalSources()
      .filter((path) =>
        ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(ExternalDaemonStorageAccessInventory.repositoryRoot, path));
  }

  static containsDirectStorageAccess(sourceText: string): boolean {
    const program = ExternalDaemonStorageAccessInventory.sourceProgram(sourceText);
    const sourceFile = program.getSourceFile("source.ts");
    if (sourceFile === undefined) return false;
    const checker = program.getTypeChecker();
    const pathBuilders = ExternalDaemonStorageAccessInventory.pathBuilders(sourceFile, checker);
    return ExternalDaemonStorageAccessInventory.containsStorageCoordinate(
      sourceFile,
      pathBuilders,
      checker,
    );
  }

  private static externalSources(): readonly string[] {
    const appSources = ExternalDaemonStorageAccessInventory.files(
      join(ExternalDaemonStorageAccessInventory.repositoryRoot, "apps"),
    );
    const packageSources = readdirSync(
      join(ExternalDaemonStorageAccessInventory.repositoryRoot, "packages"),
    )
      .filter((name) => name !== "daemon")
      .filter((name) =>
        statSync(
          join(ExternalDaemonStorageAccessInventory.repositoryRoot, "packages", name),
        ).isDirectory(),
      )
      .flatMap((name) =>
        ExternalDaemonStorageAccessInventory.files(
          join(ExternalDaemonStorageAccessInventory.repositoryRoot, "packages", name),
        ),
      )
      .filter(
        (path) =>
          /[/\\](?:test|tests|benchmark|benchmarks)[/\\]/.test(path) || /\.test\.tsx?$/.test(path),
      );
    return [...appSources, ...packageSources].filter((path) => /\.tsx?$/.test(path));
  }

  private static files(directory: string): readonly string[] {
    return readdirSync(directory)
      .filter((name) => name !== "node_modules" && name !== "dist")
      .flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory()
          ? ExternalDaemonStorageAccessInventory.files(path)
          : [path];
      });
  }

  private static sourceProgram(sourceText: string): ts.Program {
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.Latest,
    };
    const sourceFile = ts.createSourceFile(
      "source.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const host = ts.createCompilerHost(options, true);
    host.fileExists = (fileName) => fileName === "source.ts";
    host.getSourceFile = (fileName) => (fileName === "source.ts" ? sourceFile : undefined);
    host.readFile = (fileName) => (fileName === "source.ts" ? sourceText : undefined);
    return ts.createProgram(["source.ts"], options, host);
  }

  private static pathBuilders(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
  ): PathBuilderAliases {
    const functions = new Set<ts.Symbol>();
    const namespaces = new Set<ts.Symbol>();
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression) &&
        ["node:path", "path"].includes(statement.moduleReference.expression.text)
      ) {
        ExternalDaemonStorageAccessInventory.addSymbol(statement.name, namespaces, checker);
        continue;
      }
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      if (!["node:path", "path"].includes(statement.moduleSpecifier.text)) continue;
      ExternalDaemonStorageAccessInventory.addSymbol(
        statement.importClause?.name,
        namespaces,
        checker,
      );
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        ExternalDaemonStorageAccessInventory.addSymbol(bindings.name, namespaces, checker);
        continue;
      }
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        if (!["join", "resolve"].includes(importedName)) continue;
        ExternalDaemonStorageAccessInventory.addSymbol(element.name, functions, checker);
      }
    }
    return { functions, namespaces };
  }

  private static addSymbol(
    identifier: ts.Identifier | undefined,
    symbols: Set<ts.Symbol>,
    checker: ts.TypeChecker,
  ): void {
    if (identifier === undefined) return;
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol !== undefined) symbols.add(symbol);
  }

  private static containsStorageCoordinate(
    node: ts.Node,
    pathBuilders: PathBuilderAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (
      ExternalDaemonStorageAccessInventory.literalText(node) !== undefined &&
      /(?:^|[/\\])daemons(?:[/\\]|$)/.test(
        ExternalDaemonStorageAccessInventory.literalText(node) as string,
      ) &&
      ExternalDaemonStorageAccessInventory.literalText(node) !== "daemons"
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      ExternalDaemonStorageAccessInventory.isPathBuilder(node.expression, pathBuilders, checker) &&
      node.arguments.some((argument) =>
        ExternalDaemonStorageAccessInventory.hasDaemonSegment(argument),
      )
    ) {
      return true;
    }
    return node
      .getChildren()
      .some((child) =>
        ExternalDaemonStorageAccessInventory.containsStorageCoordinate(
          child,
          pathBuilders,
          checker,
        ),
      );
  }

  private static hasDaemonSegment(node: ts.Node): boolean {
    if (ExternalDaemonStorageAccessInventory.literalText(node) === "daemons") return true;
    return node
      .getChildren()
      .some((child) => ExternalDaemonStorageAccessInventory.hasDaemonSegment(child));
  }

  private static isPathBuilder(
    expression: ts.Expression,
    aliases: PathBuilderAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      return symbol !== undefined && aliases.functions.has(symbol);
    }
    if (
      !ts.isPropertyAccessExpression(expression) ||
      !["join", "resolve"].includes(expression.name.text) ||
      !ts.isIdentifier(expression.expression)
    ) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(expression.expression);
    return symbol !== undefined && aliases.namespaces.has(symbol);
  }

  private static literalText(node: ts.Node): string | undefined {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      return (node as ts.TemplateLiteralLikeNode).text;
    }
    return undefined;
  }
}

describe("external daemon storage boundary", () => {
  it.each([
    [
      "default node-prefixed POSIX join",
      'import path from "node:path"; path.posix.join(stateDirectory, "daemons");',
    ],
    [
      "default unprefixed Windows resolve",
      'import path from "path"; path.win32.resolve(stateDirectory, "daemons");',
    ],
    [
      "namespace node-prefixed Windows join",
      'import * as path from "node:path"; path.win32.join(stateDirectory, "daemons");',
    ],
    [
      "namespace unprefixed POSIX resolve",
      'import * as path from "path"; path.posix.resolve(stateDirectory, "daemons");',
    ],
    [
      "import-equals node-prefixed POSIX resolve",
      'import path = require("node:path"); path.posix.resolve(stateDirectory, "daemons");',
    ],
    [
      "import-equals unprefixed Windows join",
      'import path = require("path"); path.win32.join(stateDirectory, "daemons");',
    ],
  ])("recognizes %s as direct daemon storage access", (_name, source) => {
    expect(ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(source)).toBe(true);
  });

  it("allows an internal nested path-builder lookalike", () => {
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        const path = { posix: { join: (...segments: string[]) => segments.join("/") } };
        path.posix.join(stateDirectory, "daemons");
      `),
    ).toBe(false);
  });

  it("recognizes direct daemon coordinates without matching public daemon data", () => {
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import { join as combine } from "node:path";
        existsSync(combine(stateDirectory, "daemons"));
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import path = require("node:path");
        readFileSync(path.resolve(stateDirectory, "daemons", workspaceIdentity));
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(
        "readFileSync(`/tmp/state/daemons/${workspaceIdentity}/registry.json`);",
      ),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        const response = '{"daemons":[]}';
        function join(...segments: string[]) { return segments.join("/"); }
        join(stateDirectory, "daemons");
      `),
    ).toBe(false);
  });

  it("keeps external tests and benchmarks outside private daemon storage", () => {
    expect(ExternalDaemonStorageAccessInventory.violations()).toEqual([]);
  });
});
