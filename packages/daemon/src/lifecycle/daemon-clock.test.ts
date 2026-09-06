import { readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { NodeDaemonClock } from "./daemon-clock.js";

describe("NodeDaemonClock", () => {
  it("keeps elapsed time monotonic when wall time moves backwards", () => {
    let wallNowMs = 1_000;
    let monotonicNowMs = 20;
    const clock = new NodeDaemonClock({
      wallNowMs: () => wallNowMs,
      monotonicNowMs: () => monotonicNowMs,
    });
    const startedAt = clock.monotonicNowMs();

    wallNowMs = -50_000;
    monotonicNowMs = 37;

    expect(clock.wallNowMs()).toBe(-50_000);
    expect(Math.max(0, clock.monotonicNowMs() - startedAt)).toBe(17);
  });

  it("clamps a skewed monotonic source without mixing absolute clocks", () => {
    let monotonicNowMs = 10;
    const clock = new NodeDaemonClock({
      wallNowMs: () => 9_000_000,
      monotonicNowMs: () => monotonicNowMs,
    });
    const startedAt = clock.monotonicNowMs();

    monotonicNowMs = 4;

    expect(Math.max(0, clock.monotonicNowMs() - startedAt)).toBe(0);
  });
});

describe("daemon production clock ownership", () => {
  it.each([
    ["constructed wall clock", "const now = new Date().getTime();"],
    ["global wall clock", "Date.now();"],
    ["global monotonic clock", "performance.now();"],
    ["global process clock", "process.hrtime.bigint();"],
    ["globalThis wall clock", "globalThis.Date.now();"],
    ["globalThis monotonic clock", "globalThis.performance.now();"],
    ["globalThis process clock", "globalThis.process.hrtime();"],
    [
      "node-prefixed named performance import",
      'import { performance as timer } from "node:perf_hooks"; timer.now();',
    ],
    [
      "node-prefixed namespace performance import",
      'import * as hooks from "node:perf_hooks"; hooks.performance.now();',
    ],
    [
      "unprefixed named performance import",
      'import { performance as timer } from "perf_hooks"; timer.now();',
    ],
    [
      "unprefixed namespace performance import",
      'import * as hooks from "perf_hooks"; hooks.performance.now();',
    ],
    [
      "unprefixed default performance import",
      'import hooks from "perf_hooks"; hooks.performance.now();',
    ],
    [
      "node-prefixed default performance import",
      'import hooks from "node:perf_hooks"; hooks.performance.now();',
    ],
    [
      "unprefixed named process import",
      'import { hrtime as timer } from "process"; timer.bigint();',
    ],
    [
      "node-prefixed named process import",
      'import { hrtime as timer } from "node:process"; timer();',
    ],
    [
      "node-prefixed namespace process import",
      'import * as processModule from "node:process"; processModule.hrtime();',
    ],
    [
      "unprefixed namespace process import",
      'import * as processModule from "process"; processModule.hrtime();',
    ],
    [
      "node-prefixed default process import",
      'import processModule from "node:process"; processModule.hrtime();',
    ],
    [
      "unprefixed default process import",
      'import processModule from "process"; processModule.hrtime();',
    ],
    [
      "node-prefixed import-equals performance namespace",
      'import hooks = require("node:perf_hooks"); hooks.performance.now();',
    ],
    [
      "unprefixed import-equals performance namespace",
      'import hooks = require("perf_hooks"); hooks.performance.now();',
    ],
    [
      "node-prefixed import-equals process namespace",
      'import processModule = require("node:process"); processModule.hrtime.bigint();',
    ],
    [
      "unprefixed import-equals process namespace",
      'import processModule = require("process"); processModule.hrtime();',
    ],
    [
      "node-prefixed dynamic performance namespace",
      'const hooks = await import("node:perf_hooks"); hooks.performance.now();',
    ],
    [
      "unprefixed dynamic performance namespace",
      'const hooks = await import("perf_hooks"); hooks.performance.now();',
    ],
    [
      "node-prefixed dynamic process namespace",
      'const processModule = await import("node:process"); processModule.hrtime.bigint();',
    ],
    [
      "unprefixed dynamic process namespace",
      'const processModule = await import("process"); processModule.hrtime();',
    ],
    [
      "destructured dynamic performance import",
      'const { performance: timer } = await import("node:perf_hooks"); timer.now();',
    ],
    [
      "destructured dynamic process import",
      'const { hrtime: timer } = await import("process"); timer.bigint();',
    ],
    [
      "dynamic performance import with options",
      'const hooks = await import("node:perf_hooks", { with: {} }); hooks.performance.now();',
    ],
  ])("recognizes %s as a raw clock source", (_name, source) => {
    expect(DaemonRawClockSourceInventory.hasRawClock(source)).toBe(true);
  });

  it.each([
    ["Date", "const Date = { now: () => 1 }; Date.now();"],
    ["performance", "const performance = { now: () => 1 }; performance.now();"],
    ["process", "const process = { hrtime: () => 1 }; process.hrtime();"],
    [
      "import alias",
      'import { performance as timer } from "perf_hooks"; function read(timer: { now(): number }) { return timer.now(); }',
    ],
    [
      "performance namespace",
      "namespace hooks { export const performance = { now: () => 1 }; } hooks.performance.now();",
    ],
    [
      "process namespace",
      "namespace InternalProcess { export const hrtime = () => 1; } import processModule = InternalProcess; processModule.hrtime();",
    ],
    [
      "performance import-equals namespace",
      "namespace InternalHooks { export const performance = { now: () => 1 }; } import hooks = InternalHooks; hooks.performance.now();",
    ],
    [
      "unrelated dynamic module",
      'const hooks = await import("./perf-hooks.js"); hooks.performance.now();',
    ],
  ])("ignores a locally shadowed %s lookalike", (_name, source) => {
    expect(DaemonRawClockSourceInventory.hasRawClock(source)).toBe(false);
  });

  it("ignores clock spellings that do not acquire time", () => {
    expect(
      DaemonRawClockSourceInventory.hasRawClock(`
        const description = "Date.now performance.now process.hrtime";
        const domain = { Date: { now: () => 1 } };
        domain.Date.now();
      `),
    ).toBe(false);
  });

  it.each([
    'import telemetry = require("@symnav/telemetry");',
    'import telemetry = require("@symnav/telemetry/testing");',
  ])("recognizes an import-equals telemetry dependency", (source) => {
    expect(DaemonRawClockSourceInventory.hasRawClock(source)).toBe(true);
  });

  it("keeps raw time sources and telemetry clocks outside daemon mechanisms", () => {
    const sourceRoot = new URL("../", import.meta.url);
    const violations = DaemonProductionSourceInventory.read(sourceRoot).flatMap((file) => {
      if (file.endsWith("/lifecycle/daemon-clock.ts")) return [];
      const source = readFileSync(file, "utf8");
      return DaemonRawClockSourceInventory.hasRawClock(source) ? [file] : [];
    });

    expect(violations).toEqual([]);
  });
});

interface RawClockAliases {
  readonly performance: ReadonlySet<ts.Symbol>;
  readonly performanceNamespaces: ReadonlySet<ts.Symbol>;
  readonly hrtime: ReadonlySet<ts.Symbol>;
  readonly processNamespaces: ReadonlySet<ts.Symbol>;
}

class DaemonRawClockSourceInventory {
  static hasRawClock(sourceText: string): boolean {
    const program = DaemonRawClockSourceInventory.sourceProgram(sourceText);
    const sourceFile = program.getSourceFile("source.ts");
    if (sourceFile === undefined) return false;
    const checker = program.getTypeChecker();
    const aliases = DaemonRawClockSourceInventory.clockAliases(sourceFile, checker);
    return DaemonRawClockSourceInventory.containsRawClock(sourceFile, aliases, checker);
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

  private static clockAliases(sourceFile: ts.SourceFile, checker: ts.TypeChecker): RawClockAliases {
    const performance = new Set<ts.Symbol>();
    const performanceNamespaces = new Set<ts.Symbol>();
    const hrtime = new Set<ts.Symbol>();
    const processNamespaces = new Set<ts.Symbol>();
    for (const statement of sourceFile.statements) {
      const moduleName = DaemonRawClockSourceInventory.moduleSpecifier(statement);
      if (moduleName === undefined) continue;
      if (ts.isImportEqualsDeclaration(statement)) {
        if (["node:perf_hooks", "perf_hooks"].includes(moduleName)) {
          DaemonRawClockSourceInventory.addSymbol(statement.name, performanceNamespaces, checker);
        }
        if (["node:process", "process"].includes(moduleName)) {
          DaemonRawClockSourceInventory.addSymbol(statement.name, processNamespaces, checker);
        }
        continue;
      }
      if (!ts.isImportDeclaration(statement)) continue;
      if (["node:perf_hooks", "perf_hooks"].includes(moduleName)) {
        DaemonRawClockSourceInventory.collectImportAliases(
          statement.importClause,
          "performance",
          performance,
          performanceNamespaces,
          checker,
        );
      }
      if (["node:process", "process"].includes(moduleName)) {
        DaemonRawClockSourceInventory.collectImportAliases(
          statement.importClause,
          "hrtime",
          hrtime,
          processNamespaces,
          checker,
        );
      }
    }
    return { performance, performanceNamespaces, hrtime, processNamespaces };
  }

  private static collectImportAliases(
    importClause: ts.ImportClause | undefined,
    importedName: string,
    aliases: Set<ts.Symbol>,
    namespaces: Set<ts.Symbol>,
    checker: ts.TypeChecker,
  ): void {
    if (importClause === undefined) return;
    DaemonRawClockSourceInventory.addSymbol(importClause.name, namespaces, checker);
    const bindings = importClause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      DaemonRawClockSourceInventory.addSymbol(bindings.name, namespaces, checker);
      return;
    }
    for (const element of bindings.elements) {
      const sourceName = (element.propertyName ?? element.name).text;
      if (sourceName === importedName) {
        DaemonRawClockSourceInventory.addSymbol(element.name, aliases, checker);
      }
      if (sourceName === "default") {
        DaemonRawClockSourceInventory.addSymbol(element.name, namespaces, checker);
      }
    }
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

  private static containsRawClock(
    node: ts.Node,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
  ): boolean {
    const moduleName = DaemonRawClockSourceInventory.moduleSpecifier(node);
    if (
      DaemonRawClockSourceInventory.isDynamicImport(node) &&
      DaemonRawClockSourceInventory.isClockBuiltin(moduleName)
    ) {
      return true;
    }
    if (
      moduleName === "@symnav/telemetry" ||
      moduleName?.startsWith("@symnav/telemetry/") === true
    ) {
      return true;
    }
    if (
      ts.isNewExpression(node) &&
      DaemonRawClockSourceInventory.isGlobalMember(node.expression, "Date", checker)
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      (DaemonRawClockSourceInventory.isGlobalMember(node.expression, "Date", checker) ||
        DaemonRawClockSourceInventory.hasSymbol(node.expression, aliases.hrtime, checker))
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      DaemonRawClockSourceInventory.isRawClockProperty(node, aliases, checker)
    ) {
      return true;
    }
    return node
      .getChildren()
      .some((child) => DaemonRawClockSourceInventory.containsRawClock(child, aliases, checker));
  }

  private static isRawClockProperty(
    expression: ts.PropertyAccessExpression,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (
      expression.name.text === "now" &&
      (DaemonRawClockSourceInventory.isGlobalMember(expression.expression, "Date", checker) ||
        DaemonRawClockSourceInventory.isPerformance(expression.expression, aliases, checker))
    ) {
      return true;
    }
    if (
      expression.name.text === "hrtime" &&
      DaemonRawClockSourceInventory.isProcess(expression.expression, aliases, checker)
    ) {
      return true;
    }
    return (
      expression.name.text === "bigint" &&
      DaemonRawClockSourceInventory.isHrtime(expression.expression, aliases, checker)
    );
  }

  private static isHrtime(
    expression: ts.Expression,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (DaemonRawClockSourceInventory.hasSymbol(expression, aliases.hrtime, checker)) return true;
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "hrtime" &&
      DaemonRawClockSourceInventory.isProcess(expression.expression, aliases, checker)
    );
  }

  private static isPerformance(
    expression: ts.Expression,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isIdentifier(expression)) {
      return (
        DaemonRawClockSourceInventory.isGlobalIdentifier(expression, "performance", checker) ||
        DaemonRawClockSourceInventory.hasSymbol(expression, aliases.performance, checker)
      );
    }
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "performance" &&
      (DaemonRawClockSourceInventory.isGlobalObject(expression.expression, checker) ||
        DaemonRawClockSourceInventory.hasSymbol(
          expression.expression,
          aliases.performanceNamespaces,
          checker,
        ))
    );
  }

  private static isProcess(
    expression: ts.Expression,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isIdentifier(expression)) {
      return (
        DaemonRawClockSourceInventory.isGlobalIdentifier(expression, "process", checker) ||
        DaemonRawClockSourceInventory.hasSymbol(expression, aliases.processNamespaces, checker)
      );
    }
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "process" &&
      DaemonRawClockSourceInventory.isGlobalObject(expression.expression, checker)
    );
  }

  private static isGlobalMember(
    expression: ts.Expression,
    member: string,
    checker: ts.TypeChecker,
  ): boolean {
    return (
      (ts.isIdentifier(expression) &&
        DaemonRawClockSourceInventory.isGlobalIdentifier(expression, member, checker)) ||
      (ts.isPropertyAccessExpression(expression) &&
        expression.name.text === member &&
        DaemonRawClockSourceInventory.isGlobalObject(expression.expression, checker))
    );
  }

  private static isGlobalObject(expression: ts.Expression, checker: ts.TypeChecker): boolean {
    return (
      ts.isIdentifier(expression) &&
      DaemonRawClockSourceInventory.isGlobalIdentifier(expression, "globalThis", checker)
    );
  }

  private static isGlobalIdentifier(
    identifier: ts.Identifier,
    name: string,
    checker: ts.TypeChecker,
  ): boolean {
    if (identifier.text !== name) return false;
    const symbol = checker.getSymbolAtLocation(identifier);
    return (
      symbol === undefined || symbol.declarations === undefined || symbol.declarations.length === 0
    );
  }

  private static hasSymbol(
    expression: ts.Expression,
    symbols: ReadonlySet<ts.Symbol>,
    checker: ts.TypeChecker,
  ): boolean {
    if (!ts.isIdentifier(expression)) return false;
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol !== undefined && symbols.has(symbol);
  }

  private static moduleSpecifier(node: ts.Node): string | undefined {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return DaemonRawClockSourceInventory.literalText(node.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      return DaemonRawClockSourceInventory.literalText(node.moduleReference.expression);
    }
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      return undefined;
    }
    return DaemonRawClockSourceInventory.literalText(node.arguments[0]);
  }

  private static isDynamicImport(node: ts.Node): node is ts.CallExpression {
    return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
  }

  private static isClockBuiltin(moduleName: string | undefined): boolean {
    return ["node:perf_hooks", "perf_hooks", "node:process", "process"].includes(moduleName ?? "");
  }

  private static literalText(node: ts.Node | undefined): string | undefined {
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
  }
}

class DaemonProductionSourceInventory {
  static read(directory: URL): readonly string[] {
    return readdirSync(directory).flatMap((name) => {
      const entry = new URL(name, directory);
      if (statSync(entry).isDirectory()) {
        return DaemonProductionSourceInventory.read(new URL(`${name}/`, directory));
      }
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [entry.pathname] : [];
    });
  }
}
