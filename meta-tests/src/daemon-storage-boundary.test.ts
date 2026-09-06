import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

interface PathBuilderAliases {
  readonly functions: ReadonlySet<ts.Symbol>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
}

interface FileSystemAliases {
  readonly functions: ReadonlySet<ts.Symbol>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
}

type MemberAccessExpression = ts.PropertyAccessExpression | ts.ElementAccessExpression;

interface StaticStorageAlias {
  readonly source: ts.Expression;
  readonly members: readonly string[];
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
    const fileSystem = ExternalDaemonStorageAccessInventory.fileSystemAliases(sourceFile, checker);
    return ExternalDaemonStorageAccessInventory.containsStorageCoordinate(
      sourceFile,
      pathBuilders,
      fileSystem,
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

  private static fileSystemAliases(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
  ): FileSystemAliases {
    const functions = new Set<ts.Symbol>();
    const namespaces = new Set<ts.Symbol>();
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression) &&
        ["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(
          statement.moduleReference.expression.text,
        )
      ) {
        ExternalDaemonStorageAccessInventory.addSymbol(statement.name, namespaces, checker);
        continue;
      }
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      if (
        !["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(
          statement.moduleSpecifier.text,
        )
      ) {
        continue;
      }
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
        ExternalDaemonStorageAccessInventory.addSymbol(
          element.name,
          importedName === "promises" ? namespaces : functions,
          checker,
        );
      }
    }
    return { functions, namespaces };
  }

  private static containsStorageCoordinate(
    node: ts.Node,
    pathBuilders: PathBuilderAliases,
    fileSystem: FileSystemAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (
      ts.isCallExpression(node) &&
      ExternalDaemonStorageAccessInventory.isPathBuilder(node.expression, pathBuilders, checker) &&
      node.arguments.some((argument) =>
        ExternalDaemonStorageAccessInventory.hasDaemonSegment(argument, checker, new Set()),
      ) &&
      node.arguments.some((argument) =>
        ExternalDaemonStorageAccessInventory.hasStorageRoot(argument, checker, new Set()),
      )
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      ExternalDaemonStorageAccessInventory.isFileSystemCall(node.expression, fileSystem, checker) &&
      node.arguments.some((argument) =>
        ExternalDaemonStorageAccessInventory.hasDaemonStoragePath(
          argument,
          pathBuilders,
          checker,
          new Set(),
        ),
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
          fileSystem,
          checker,
        ),
      );
  }

  private static hasDaemonSegment(
    node: ts.Node,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    if (
      ts.isExpression(node) &&
      ExternalDaemonStorageAccessInventory.staticString(node, checker, visitedSymbols) === "daemons"
    ) {
      return true;
    }
    return node
      .getChildren()
      .some((child) =>
        ExternalDaemonStorageAccessInventory.hasDaemonSegment(child, checker, visitedSymbols),
      );
  }

  private static hasStorageRoot(
    node: ts.Node,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    if (ts.isExpression(node)) {
      const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(node);
      if (ts.isIdentifier(unwrapped)) {
        if (/^(?:state|daemonState)(?:Directory|Dir|Root)$/.test(unwrapped.text)) return true;
        const symbol = checker.getSymbolAtLocation(unwrapped);
        if (symbol !== undefined && !visitedSymbols.has(symbol)) {
          const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
          if (alias !== undefined && alias.members.length === 0) {
            const nextVisitedSymbols = new Set(visitedSymbols);
            nextVisitedSymbols.add(symbol);
            if (
              ExternalDaemonStorageAccessInventory.hasStorageRoot(
                alias.source,
                checker,
                nextVisitedSymbols,
              )
            ) {
              return true;
            }
          }
        }
      }
    }
    return node
      .getChildren()
      .some((child) =>
        ExternalDaemonStorageAccessInventory.hasStorageRoot(child, checker, visitedSymbols),
      );
  }

  private static hasDaemonStoragePath(
    node: ts.Node,
    pathBuilders: PathBuilderAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    const literalText = ExternalDaemonStorageAccessInventory.literalText(node);
    if (literalText !== undefined && /(?:^|[/\\])daemons(?:[/\\]|$)/.test(literalText)) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      ExternalDaemonStorageAccessInventory.isPathBuilder(node.expression, pathBuilders, checker) &&
      node.arguments.some((argument) =>
        ExternalDaemonStorageAccessInventory.hasDaemonSegment(argument, checker, visitedSymbols),
      )
    ) {
      return true;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && !visitedSymbols.has(symbol)) {
        const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
        if (alias !== undefined && alias.members.length === 0) {
          const nextVisitedSymbols = new Set(visitedSymbols);
          nextVisitedSymbols.add(symbol);
          if (
            ExternalDaemonStorageAccessInventory.hasDaemonStoragePath(
              alias.source,
              pathBuilders,
              checker,
              nextVisitedSymbols,
            )
          ) {
            return true;
          }
        }
      }
    }
    return node
      .getChildren()
      .some((child) =>
        ExternalDaemonStorageAccessInventory.hasDaemonStoragePath(
          child,
          pathBuilders,
          checker,
          visitedSymbols,
        ),
      );
  }

  private static isPathBuilder(
    expression: ts.Expression,
    aliases: PathBuilderAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean {
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      if (symbol !== undefined && aliases.functions.has(symbol)) return true;
    }
    if (
      ExternalDaemonStorageAccessInventory.isMemberAccess(unwrapped) &&
      ["join", "resolve"].includes(
        ExternalDaemonStorageAccessInventory.memberName(unwrapped, checker) ?? "",
      ) &&
      ExternalDaemonStorageAccessInventory.isPathNamespace(
        unwrapped.expression,
        aliases,
        checker,
        visitedSymbols,
      )
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return false;
    const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
    if (alias === undefined) return false;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    if (alias.members.length === 0) {
      return ExternalDaemonStorageAccessInventory.isPathBuilder(
        alias.source,
        aliases,
        checker,
        nextVisitedSymbols,
      );
    }
    const builderName = alias.members.at(-1);
    return (
      builderName !== undefined &&
      ["join", "resolve"].includes(builderName) &&
      ExternalDaemonStorageAccessInventory.isPathNamespacePath(
        alias.source,
        alias.members.slice(0, -1),
        aliases,
        checker,
        nextVisitedSymbols,
      )
    );
  }

  private static isPathNamespace(
    expression: ts.Expression,
    aliases: PathBuilderAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean {
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    if (
      ["node:path", "path"].includes(
        ExternalDaemonStorageAccessInventory.dynamicModuleName(unwrapped) ?? "",
      )
    ) {
      return true;
    }
    if (ts.isIdentifier(unwrapped)) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      if (symbol !== undefined && aliases.namespaces.has(symbol)) return true;
    }
    if (
      ExternalDaemonStorageAccessInventory.isMemberAccess(unwrapped) &&
      ["posix", "win32"].includes(
        ExternalDaemonStorageAccessInventory.memberName(unwrapped, checker) ?? "",
      ) &&
      ExternalDaemonStorageAccessInventory.isPathNamespace(
        unwrapped.expression,
        aliases,
        checker,
        visitedSymbols,
      )
    ) {
      return true;
    }
    if (
      ExternalDaemonStorageAccessInventory.isMemberAccess(unwrapped) &&
      ExternalDaemonStorageAccessInventory.memberName(unwrapped, checker) === "default" &&
      ExternalDaemonStorageAccessInventory.isDynamicBuiltinNamespace(
        unwrapped.expression,
        ["node:path", "path"],
        checker,
      )
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return false;
    const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
    if (alias === undefined) return false;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    return ExternalDaemonStorageAccessInventory.isPathNamespacePath(
      alias.source,
      alias.members,
      aliases,
      checker,
      nextVisitedSymbols,
    );
  }

  private static isPathNamespacePath(
    source: ts.Expression,
    members: readonly string[],
    aliases: PathBuilderAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    if (members.length === 0) {
      return ExternalDaemonStorageAccessInventory.isPathNamespace(
        source,
        aliases,
        checker,
        visitedSymbols,
      );
    }
    const memberName = members.at(-1);
    if (memberName === "default") {
      return (
        members.length === 1 &&
        ExternalDaemonStorageAccessInventory.isDynamicBuiltinNamespace(
          source,
          ["node:path", "path"],
          checker,
        )
      );
    }
    if (memberName === undefined || !["posix", "win32"].includes(memberName)) return false;
    return ExternalDaemonStorageAccessInventory.isPathNamespacePath(
      source,
      members.slice(0, -1),
      aliases,
      checker,
      visitedSymbols,
    );
  }

  private static isFileSystemCall(
    expression: ts.Expression,
    aliases: FileSystemAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean {
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      if (symbol !== undefined && aliases.functions.has(symbol)) return true;
    }
    if (
      ExternalDaemonStorageAccessInventory.isMemberAccess(unwrapped) &&
      ExternalDaemonStorageAccessInventory.memberName(unwrapped, checker) !== "then" &&
      ExternalDaemonStorageAccessInventory.isFileSystemNamespace(
        unwrapped.expression,
        aliases,
        checker,
        visitedSymbols,
      )
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return false;
    const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
    if (alias === undefined) return false;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    if (alias.members.length === 0) {
      return ExternalDaemonStorageAccessInventory.isFileSystemCall(
        alias.source,
        aliases,
        checker,
        nextVisitedSymbols,
      );
    }
    const functionName = alias.members.at(-1);
    return (
      functionName !== undefined &&
      functionName !== "promises" &&
      ExternalDaemonStorageAccessInventory.isFileSystemNamespacePath(
        alias.source,
        alias.members.slice(0, -1),
        aliases,
        checker,
        nextVisitedSymbols,
      )
    );
  }

  private static isFileSystemNamespace(
    expression: ts.Expression,
    aliases: FileSystemAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean {
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    if (
      ["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(
        ExternalDaemonStorageAccessInventory.dynamicModuleName(unwrapped) ?? "",
      )
    ) {
      return true;
    }
    if (ts.isIdentifier(unwrapped)) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      if (symbol !== undefined && aliases.namespaces.has(symbol)) return true;
    }
    if (
      ExternalDaemonStorageAccessInventory.isMemberAccess(unwrapped) &&
      ExternalDaemonStorageAccessInventory.memberName(unwrapped, checker) === "promises" &&
      ExternalDaemonStorageAccessInventory.isFileSystemNamespace(
        unwrapped.expression,
        aliases,
        checker,
        visitedSymbols,
      )
    ) {
      return true;
    }
    if (
      ExternalDaemonStorageAccessInventory.isMemberAccess(unwrapped) &&
      ExternalDaemonStorageAccessInventory.memberName(unwrapped, checker) === "default" &&
      ExternalDaemonStorageAccessInventory.isDynamicBuiltinNamespace(
        unwrapped.expression,
        ["node:fs", "fs", "node:fs/promises", "fs/promises"],
        checker,
      )
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return false;
    const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
    if (alias === undefined) return false;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    return ExternalDaemonStorageAccessInventory.isFileSystemNamespacePath(
      alias.source,
      alias.members,
      aliases,
      checker,
      nextVisitedSymbols,
    );
  }

  private static isFileSystemNamespacePath(
    source: ts.Expression,
    members: readonly string[],
    aliases: FileSystemAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    if (members.length === 0) {
      return ExternalDaemonStorageAccessInventory.isFileSystemNamespace(
        source,
        aliases,
        checker,
        visitedSymbols,
      );
    }
    const memberName = members.at(-1);
    if (memberName === "default") {
      return (
        members.length === 1 &&
        ExternalDaemonStorageAccessInventory.isDynamicBuiltinNamespace(
          source,
          ["node:fs", "fs", "node:fs/promises", "fs/promises"],
          checker,
        )
      );
    }
    if (memberName !== "promises") return false;
    return ExternalDaemonStorageAccessInventory.isFileSystemNamespacePath(
      source,
      members.slice(0, -1),
      aliases,
      checker,
      visitedSymbols,
    );
  }

  private static staticStorageAlias(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
  ): StaticStorageAlias | undefined {
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ExternalDaemonStorageAccessInventory.isConstVariable(declaration)
      ) {
        return { source: declaration.initializer, members: [] };
      }
      if (ts.isParameter(declaration) && ts.isIdentifier(declaration.name)) {
        const source = ExternalDaemonStorageAccessInventory.immediateDynamicImportCallbackSource(
          declaration,
          checker,
        );
        if (source !== undefined) return { source, members: [] };
      }
      if (ts.isBindingElement(declaration)) {
        const alias = ExternalDaemonStorageAccessInventory.bindingAlias(declaration, checker);
        if (alias !== undefined) return alias;
      }
    }
    return undefined;
  }

  private static bindingAlias(
    declaration: ts.BindingElement,
    checker: ts.TypeChecker,
  ): StaticStorageAlias | undefined {
    const members: string[] = [];
    let bindingElement = declaration;
    while (true) {
      if (bindingElement.dotDotDotToken !== undefined) return undefined;
      const memberNode = bindingElement.propertyName ?? bindingElement.name;
      const memberName = ExternalDaemonStorageAccessInventory.staticPropertyName(
        memberNode,
        checker,
      );
      if (memberName === undefined) return undefined;
      members.unshift(memberName);
      const bindingPattern = bindingElement.parent;
      if (!ts.isObjectBindingPattern(bindingPattern)) return undefined;
      const owner = bindingPattern.parent;
      if (ts.isVariableDeclaration(owner)) {
        if (
          owner.initializer === undefined ||
          !ExternalDaemonStorageAccessInventory.isConstVariable(owner)
        ) {
          return undefined;
        }
        return { source: owner.initializer, members };
      }
      if (ts.isParameter(owner)) {
        const source = ExternalDaemonStorageAccessInventory.immediateDynamicImportCallbackSource(
          owner,
          checker,
        );
        return source === undefined ? undefined : { source, members };
      }
      if (!ts.isBindingElement(owner)) return undefined;
      bindingElement = owner;
    }
  }

  private static isConstVariable(declaration: ts.VariableDeclaration): boolean {
    return (
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    );
  }

  private static immediateDynamicImportCallbackSource(
    parameter: ts.ParameterDeclaration,
    checker: ts.TypeChecker,
  ): ts.Expression | undefined {
    const callback = parameter.parent;
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return undefined;
    if (callback.parameters[0] !== parameter) return undefined;
    const thenCall = callback.parent;
    if (!ts.isCallExpression(thenCall) || thenCall.arguments[0] !== callback) return undefined;
    const thenMember = ExternalDaemonStorageAccessInventory.unwrapExpression(thenCall.expression);
    if (
      !ExternalDaemonStorageAccessInventory.isMemberAccess(thenMember) ||
      ExternalDaemonStorageAccessInventory.memberName(thenMember, checker) !== "then"
    ) {
      return undefined;
    }
    const importExpression = ExternalDaemonStorageAccessInventory.unwrapExpression(
      thenMember.expression,
    );
    return ExternalDaemonStorageAccessInventory.dynamicModuleName(importExpression) === undefined
      ? undefined
      : importExpression;
  }

  private static isDynamicBuiltinNamespace(
    expression: ts.Expression,
    moduleNames: readonly string[],
    checker: ts.TypeChecker,
  ): boolean {
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    if (
      moduleNames.includes(ExternalDaemonStorageAccessInventory.dynamicModuleName(unwrapped) ?? "")
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined) return false;
    const alias = ExternalDaemonStorageAccessInventory.staticStorageAlias(symbol, checker);
    return (
      alias?.members.length === 0 &&
      moduleNames.includes(
        ExternalDaemonStorageAccessInventory.dynamicModuleName(alias.source) ?? "",
      )
    );
  }

  private static staticPropertyName(node: ts.Node, checker: ts.TypeChecker): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) {
      return ExternalDaemonStorageAccessInventory.staticString(node.expression, checker, new Set());
    }
    return undefined;
  }

  private static isMemberAccess(node: ts.Node): node is MemberAccessExpression {
    return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  }

  private static memberName(
    expression: MemberAccessExpression,
    checker: ts.TypeChecker,
  ): string | undefined {
    return ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ExternalDaemonStorageAccessInventory.staticString(
          expression.argumentExpression,
          checker,
          new Set(),
        );
  }

  private static staticString(
    expression: ts.Expression | undefined,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): string | undefined {
    if (expression === undefined) return undefined;
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    const literal = ExternalDaemonStorageAccessInventory.literalText(unwrapped);
    if (literal !== undefined) return literal;
    if (!ts.isIdentifier(unwrapped)) return undefined;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return undefined;
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.initializer !== undefined &&
        ExternalDaemonStorageAccessInventory.isConstVariable(candidate),
    );
    if (declaration?.initializer === undefined) return undefined;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    return ExternalDaemonStorageAccessInventory.staticString(
      declaration.initializer,
      checker,
      nextVisitedSymbols,
    );
  }

  private static unwrapExpression(expression: ts.Expression): ts.Expression {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return ExternalDaemonStorageAccessInventory.unwrapExpression(expression.expression);
    }
    return expression;
  }

  private static dynamicModuleName(expression: ts.Expression): string | undefined {
    const unwrapped = ExternalDaemonStorageAccessInventory.unwrapExpression(expression);
    const importExpression = ts.isAwaitExpression(unwrapped)
      ? ExternalDaemonStorageAccessInventory.unwrapExpression(unwrapped.expression)
      : unwrapped;
    if (
      !ts.isCallExpression(importExpression) ||
      importExpression.expression.kind !== ts.SyntaxKind.ImportKeyword
    ) {
      return undefined;
    }
    return ExternalDaemonStorageAccessInventory.literalText(importExpression.arguments[0]);
  }

  private static literalText(node: ts.Node | undefined): string | undefined {
    if (node === undefined) return undefined;
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
    [
      "parenthesized default path namespace",
      'import path from "node:path"; (path).join(stateDirectory, "daemons");',
    ],
    [
      "non-null path namespace",
      'import * as path from "path"; path!.win32.resolve(stateDirectory, "daemons");',
    ],
    [
      "as-cast import-equals path namespace",
      'import path = require("node:path"); (path as typeof path).posix.join(stateDirectory, "daemons");',
    ],
    [
      "destructured POSIX path builder",
      'import * as path from "node:path"; const { join: build } = path.posix; build(stateDirectory, "daemons");',
    ],
    [
      "nested destructured Windows path builder",
      'import path from "path"; const { win32: { resolve: build } } = path; build(stateDirectory, "daemons");',
    ],
    [
      "aliased path namespace destructuring",
      'import path from "node:path"; const platform = path.posix; const { join: build } = platform; build(stateDirectory, "daemons");',
    ],
    [
      "dynamic node-prefixed path namespace",
      'const path = await import("node:path"); path.join(stateDirectory, "daemons");',
    ],
    [
      "dynamic unprefixed path binding",
      'const { resolve: build } = await import("path"); build(stateDirectory, "daemons");',
    ],
    [
      "dynamic platform path binding chain",
      'const { posix } = await import("node:path"); const { join: build } = posix; build(stateDirectory, "daemons");',
    ],
  ])("recognizes %s as direct daemon storage access", (_name, source) => {
    expect(ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(source)).toBe(true);
  });

  it.each([
    [
      "promise node-prefixed path default member",
      'import("node:path").then((module) => module.default.join(stateDirectory, "daemons"));',
    ],
    [
      "promise unprefixed path default member",
      'import("path").then((module) => module.default.resolve(stateDirectory, "daemons"));',
    ],
    [
      "promise node-prefixed path default binding",
      'import("node:path").then(({ default: path }) => path.posix.join(stateDirectory, "daemons"));',
    ],
    [
      "promise unprefixed path default binding",
      'import("path").then(({ default: path }) => path.win32.resolve(stateDirectory, "daemons"));',
    ],
    [
      "promise node-prefixed filesystem default member",
      'import("node:fs").then((module) => module.default.readFileSync("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem default member",
      'import("fs").then((module) => module.default.promises.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed filesystem default binding",
      'import("node:fs").then(({ default: files }) => files.readFileSync("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem default binding",
      'import("fs").then(({ default: files }) => files.promises.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed filesystem-promises default member",
      'import("node:fs/promises").then((module) => module.default.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem-promises default member",
      'import("fs/promises").then((module) => module.default.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed filesystem-promises default binding",
      'import("node:fs/promises").then(({ default: files }) => files.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem-promises default binding",
      'import("fs/promises").then(({ default: files }) => files.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed path callback-body default binding",
      'import("node:path").then((module) => { const { default: path } = module; return path.join(stateDirectory, "daemons"); });',
    ],
    [
      "promise unprefixed path callback-body default binding",
      'import("path").then((module) => { const { default: path } = module; return path.resolve(stateDirectory, "daemons"); });',
    ],
    [
      "promise node-prefixed filesystem callback-body default binding",
      'import("node:fs").then((module) => { const { default: files } = module; return files.readFileSync("/tmp/state/daemons/registry.json"); });',
    ],
    [
      "promise unprefixed filesystem callback-body default binding",
      'import("fs").then((module) => { const { default: files } = module; return files.promises.readFile("/tmp/state/daemons/registry.json"); });',
    ],
    [
      "promise node-prefixed filesystem-promises callback-body default binding",
      'import("node:fs/promises").then((module) => { const { default: files } = module; return files.readFile("/tmp/state/daemons/registry.json"); });',
    ],
    [
      "promise unprefixed filesystem-promises callback-body default binding",
      'import("fs/promises").then((module) => { const { default: files } = module; return files.readFile("/tmp/state/daemons/registry.json"); });',
    ],
  ])("recognizes %s as direct daemon storage access", (_name, source) => {
    expect(ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(source)).toBe(true);
  });

  it.each([
    [
      "promise node-prefixed path namespace",
      'import("node:path").then((path) => path.join(stateDirectory, "daemons"));',
    ],
    [
      "promise unprefixed path namespace",
      'import("path").then((path) => path.resolve(stateDirectory, "daemons"));',
    ],
    [
      "promise node-prefixed path binding",
      'import("node:path").then(({ join: build }) => build(stateDirectory, "daemons"));',
    ],
    [
      "promise unprefixed path binding",
      'import("path").then(({ win32: { resolve: build } }) => build(stateDirectory, "daemons"));',
    ],
    [
      "promise node-prefixed filesystem namespace",
      'import("node:fs").then((files) => files.readFileSync("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem namespace",
      'import("fs").then((files) => files.readFileSync("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed filesystem binding",
      'import("node:fs").then(({ readFileSync: read }) => read("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem binding",
      'import("fs").then(({ promises: { readFile: read } }) => read("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed filesystem-promises namespace",
      'import("node:fs/promises").then((files) => files.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem-promises namespace",
      'import("fs/promises").then((files) => files.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise node-prefixed filesystem-promises binding",
      'import("node:fs/promises").then(({ readFile: read }) => read("/tmp/state/daemons/registry.json"));',
    ],
    [
      "promise unprefixed filesystem-promises binding",
      'import("fs/promises").then(({ readFile: read }) => read("/tmp/state/daemons/registry.json"));',
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
        'import { readFileSync } from "node:fs"; readFileSync(`/tmp/state/daemons/${workspaceIdentity}/registry.json`);',
      ),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import * as fileSystem from "node:fs";
        fileSystem.readdirSync(stateDirectory + "/daemons");
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import * as fileSystem from "node:fs";
        const { readFileSync: read } = fileSystem;
        read("/tmp/state/daemons/registry.json");
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import fileSystem from "fs";
        (fileSystem!).readFileSync("/tmp/state/daemons/registry.json");
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import * as fileSystem from "node:fs";
        const { promises } = fileSystem;
        const { readFile: read } = promises;
        read("/tmp/state/daemons/registry.json");
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import fileSystem = require("fs");
        (fileSystem as typeof fileSystem).promises.readFile("/tmp/state/daemons/registry.json");
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        import * as fileSystem from "node:fs/promises";
        const files = fileSystem;
        const { readFile: read } = files;
        read("/tmp/state/daemons/registry.json");
      `),
    ).toBe(true);
    expect(
      ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(`
        const response = '{"daemons":[]}';
        function join(...segments: string[]) { return segments.join("/"); }
        join(stateDirectory, "daemons");
      `),
    ).toBe(false);
  });

  it.each([
    [
      "dynamic node-prefixed filesystem namespace",
      'const files = await import("node:fs"); files.readFileSync("/tmp/state/daemons/registry.json");',
    ],
    [
      "dynamic unprefixed filesystem binding",
      'const { readFileSync: read } = await import("fs"); read("/tmp/state/daemons/registry.json");',
    ],
    [
      "dynamic node-prefixed filesystem-promises namespace",
      'const files = await import("node:fs/promises"); files.readFile("/tmp/state/daemons/registry.json");',
    ],
    [
      "dynamic unprefixed filesystem-promises binding",
      'const { readFile: read } = await import("fs/promises"); read("/tmp/state/daemons/registry.json");',
    ],
    [
      "dynamic filesystem binding chain",
      'const files = await import("node:fs"); const { promises } = files; const { readFile: read } = promises; read("/tmp/state/daemons/registry.json");',
    ],
  ])("recognizes %s as direct daemon storage access", (_name, source) => {
    expect(ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(source)).toBe(true);
  });

  it.each([
    ["HTTP route", 'fetch("/api/daemons/status");'],
    ["route data", 'const route = "/api/daemons/status";'],
    ["URL data", 'new URL("/api/daemons/status", origin);'],
    [
      "path-built route data",
      'import path from "node:path"; path.posix.join("/api", "daemons", "status");',
    ],
    [
      "path-built HTTP route",
      'import path from "node:path"; fetch(path.posix.join("/api", "daemons", "status"));',
    ],
    [
      "path-built URL data",
      'import path from "node:path"; new URL(path.posix.join("/api", "daemons", "status"), origin);',
    ],
    [
      "path-built state route data",
      'import path from "node:path"; fetch(path.posix.join("/api", "state", "daemons", "status"));',
    ],
    [
      "path-built state URL data",
      'import path from "node:path"; new URL(path.posix.join("/api", "state", "daemons"), origin);',
    ],
    [
      "dynamic path-built state route data",
      'const path = await import("node:path"); fetch(path.posix.join("/api", "state", "daemons", "status"));',
    ],
    ["unused dynamic path import", 'await import("node:path");'],
    ["unused dynamic filesystem import", 'const files = await import("node:fs");'],
    ["unused promise path import", 'import("node:path").then(() => undefined);'],
    ["unused promise filesystem import", 'import("fs").then((files) => files.constants);'],
    [
      "unused promise default filesystem import",
      'import("node:fs").then((module) => module.default.constants);',
    ],
    [
      "promise path-built state route data",
      'import("node:path").then((path) => fetch(path.posix.join("/api", "state", "daemons", "status")));',
    ],
    [
      "promise path-built state URL data",
      'import("path").then(({ posix }) => new URL(posix.join("/api", "state", "daemons"), origin));',
    ],
    [
      "promise default path-built state route data",
      'import("node:path").then((module) => fetch(module.default.posix.join("/api", "state", "daemons", "status")));',
    ],
    [
      "promise default path-built state URL data",
      'import("path").then(({ default: path }) => new URL(path.posix.join("/api", "state", "daemons"), origin));',
    ],
    [
      "promise callback-body default path-built state route data",
      'import("node:path").then((module) => { const { default: path } = module; return fetch(path.posix.join("/api", "state", "daemons", "status")); });',
    ],
    [
      "unrelated promise filesystem lookalike",
      'import("./files.js").then((files) => files.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "local promise path lookalike",
      'Promise.resolve({ join: (...parts: string[]) => parts.join("/") }).then((path) => path.join(stateDirectory, "daemons"));',
    ],
    [
      "mutable promise filesystem lookalike",
      'let files = { readFile: (path: string) => path }; Promise.resolve(files).then((current) => current.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "unrelated promise default filesystem lookalike",
      'import("./files.js").then((module) => module.default.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "unrelated promise callback-body default filesystem lookalike",
      'import("./files.js").then((module) => { const { default: files } = module; return files.readFile("/tmp/state/daemons/registry.json"); });',
    ],
    [
      "local promise default filesystem lookalike",
      'Promise.resolve({ default: { readFile: (path: string) => path } }).then((module) => module.default.readFile("/tmp/state/daemons/registry.json"));',
    ],
    [
      "mutable promise default filesystem alias",
      'let files; import("node:fs").then(({ default: loaded }) => { files = loaded; }); files?.readFileSync("/tmp/state/daemons/registry.json");',
    ],
    [
      "mutable promise callback-body default filesystem binding",
      'import("node:fs").then((module) => { let { default: files } = module; return files.readFileSync("/tmp/state/daemons/registry.json"); });',
    ],
    [
      "second promise callback parameter",
      'import("node:fs").then((_module, files) => files.default.readFileSync("/tmp/state/daemons/registry.json"));',
    ],
    [
      "non-immediate promise callback",
      'const read = ({ default: files }: any) => files.readFileSync("/tmp/state/daemons/registry.json"); import("node:fs").then(read);',
    ],
    [
      "unrelated dynamic filesystem lookalike",
      'const files = await import("./files.js"); files.readFile("/tmp/state/daemons/registry.json");',
    ],
    [
      "local filesystem lookalike",
      'function readFileSync(path: string) { return path; } readFileSync("/api/daemons/status");',
    ],
    [
      "local destructured path lookalike",
      'const path = { posix: { join: (...parts: string[]) => parts.join("/") } }; const { join: build } = path.posix; build(stateDirectory, "daemons");',
    ],
    [
      "local destructured filesystem lookalike",
      'const fileSystem = { readFileSync: (path: string) => path }; const { readFileSync: read } = fileSystem; read("/tmp/state/daemons/registry.json");',
    ],
    [
      "mutable filesystem alias",
      'import * as fileSystem from "node:fs"; let files = fileSystem; files.readFileSync("/tmp/state/daemons/registry.json");',
    ],
  ])("allows slash-delimited daemon %s outside filesystem access", (_name, source) => {
    expect(ExternalDaemonStorageAccessInventory.containsDirectStorageAccess(source)).toBe(false);
  });

  it("keeps external tests and benchmarks outside private daemon storage", () => {
    expect(ExternalDaemonStorageAccessInventory.violations()).toEqual([]);
  });
});
