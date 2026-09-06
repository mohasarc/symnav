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
    ["computed wall clock", 'Date["now"]();'],
    ["computed monotonic clock", 'performance["now"]();'],
    ["computed process clock", 'process["hrtime"]();'],
    ["computed process bigint clock", 'process.hrtime["bigint"]();'],
    ["computed process clock chain", 'process["hrtime"]["bigint"]();'],
    [
      "computed imported performance clock chain",
      'import * as hooks from "node:perf_hooks"; hooks["performance"]["now"]();',
    ],
    ["parenthesized performance clock", "(performance).now();"],
    ["non-null performance clock", "performance!.now();"],
    ["as-cast performance clock", "(performance as { now(): number }).now();"],
    ["satisfies performance clock", "(performance satisfies { now(): number }).now();"],
    ["type-asserted performance clock", "(<{ now(): number }>performance).now();"],
    ["wrapped optional performance clock", "(performance)?.now?.();"],
    ["const-computed performance clock", 'const member = "now" as const; performance[member]();'],
    [
      "const-computed process clock chain",
      'const timer = "hrtime"; const precision = "bigint"; process[timer][precision]();',
    ],
    ["const performance alias", "const timer = performance; timer.now();"],
    ["const process clock alias", "const timer = process.hrtime; timer.bigint();"],
    ["destructured global performance clock", "const { now: timer } = performance; timer();"],
    ["destructured global process clock", "const { hrtime: timer } = process; timer.bigint();"],
    [
      "nested destructured global process clock",
      "const { hrtime: { bigint: timer } } = process; timer();",
    ],
    [
      "destructured imported performance",
      'import * as hooks from "node:perf_hooks"; const { performance: timer } = hooks; timer.now();',
    ],
    [
      "destructured imported process clock",
      'import processModule from "process"; const { hrtime: timer } = processModule; timer.bigint();',
    ],
    [
      "aliased imported performance destructuring",
      'import * as hooks from "perf_hooks"; const namespace = hooks; const { performance: timer } = namespace; timer.now();',
    ],
    ["callable wall clock", "Date();"],
    ["globalThis callable wall clock", "globalThis.Date();"],
    ["wrapped callable wall clock", "(Date as typeof Date)!();"],
    ["const callable wall clock alias", "const wall = Date; wall();"],
    ["destructured callable wall clock", "const { Date: wall } = globalThis; wall();"],
    [
      "destructured callable wall clock through global alias",
      "const root = globalThis; const { Date: wall } = root; wall();",
    ],
    ["callable wall clock through call", "Date.call(undefined);"],
    ["callable wall clock through apply", "globalThis.Date.apply(undefined, []);"],
    ["immediately bound callable wall clock", "(Date as typeof Date).bind(undefined)();"],
    [
      "const bound callable wall clock",
      "const wall = globalThis.Date.bind(undefined); wall();",
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
    [
      "computed local clock members",
      'const performance = { now: () => 1 }; const process = { hrtime: { bigint: () => 1 } }; performance["now"](); process["hrtime"]["bigint"]();',
    ],
    ["mutable computed global member", 'let member = "now"; performance[member]();'],
    ["mutable global performance alias", "let timer = performance; timer.now();"],
    [
      "local destructured clock",
      "const local = { now: () => 1 }; const { now: timer } = local; timer();",
    ],
    [
      "unrelated imported destructuring",
      'import * as hooks from "./perf-hooks.js"; const { performance: timer } = hooks; timer.now();',
    ],
    ["local callable Date", "function Date() { return 'fixed'; } Date();"],
    ["local callable Date through call", "function Date() { return 'fixed'; } Date.call(undefined);"],
    ["local bound callable Date", "function Date() { return 'fixed'; } Date.bind(undefined)();"],
    ["mutable callable Date alias", "let wall = Date; wall();"],
    ["mutable bound callable Date alias", "let wall = Date.bind(undefined); wall();"],
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

type MemberAccessExpression = ts.PropertyAccessExpression | ts.ElementAccessExpression;

type ClockValue =
  | "date"
  | "global"
  | "performance"
  | "performanceNamespace"
  | "process"
  | "hrtime"
  | "now"
  | "bigint";

interface StaticBindingAlias {
  readonly source: ts.Expression;
  readonly members: readonly string[];
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
      DaemonRawClockSourceInventory.isClockValue(node.expression, "date", aliases, checker)
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      (["date", "now", "hrtime", "bigint"] as const).some((clockValue) =>
        DaemonRawClockSourceInventory.isClockValue(node.expression, clockValue, aliases, checker),
      )
    ) {
      return true;
    }
    if (
      DaemonRawClockSourceInventory.isMemberAccess(node) &&
      (["now", "hrtime", "bigint"] as const).some((clockValue) =>
        DaemonRawClockSourceInventory.isClockValue(node, clockValue, aliases, checker),
      )
    ) {
      return true;
    }
    return node
      .getChildren()
      .some((child) => DaemonRawClockSourceInventory.containsRawClock(child, aliases, checker));
  }

  private static isClockValue(
    expression: ts.Expression,
    expected: ClockValue,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean {
    const unwrapped = DaemonRawClockSourceInventory.unwrapExpression(expression);
    if (
      ts.isIdentifier(unwrapped) &&
      DaemonRawClockSourceInventory.isDirectClockIdentifier(unwrapped, expected, aliases, checker)
    ) {
      return true;
    }
    if (DaemonRawClockSourceInventory.isMemberAccess(unwrapped)) {
      const memberName = DaemonRawClockSourceInventory.memberName(unwrapped, checker);
      const ownerValues = DaemonRawClockSourceInventory.ownerValues(expected, memberName);
      if (
        ownerValues.some((ownerValue) =>
          DaemonRawClockSourceInventory.isClockValue(
            unwrapped.expression,
            ownerValue,
            aliases,
            checker,
            visitedSymbols,
          ),
        )
      ) {
        return true;
      }
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return false;
    const alias = DaemonRawClockSourceInventory.staticBindingAlias(symbol, checker);
    if (alias === undefined) return false;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    return DaemonRawClockSourceInventory.isClockMemberPath(
      alias.source,
      alias.members,
      expected,
      aliases,
      checker,
      nextVisitedSymbols,
    );
  }

  private static isDirectClockIdentifier(
    identifier: ts.Identifier,
    expected: ClockValue,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
  ): boolean {
    if (expected === "date") {
      return DaemonRawClockSourceInventory.isGlobalIdentifier(identifier, "Date", checker);
    }
    if (expected === "global") {
      return DaemonRawClockSourceInventory.isGlobalIdentifier(identifier, "globalThis", checker);
    }
    if (expected === "performance") {
      return (
        DaemonRawClockSourceInventory.isGlobalIdentifier(identifier, "performance", checker) ||
        DaemonRawClockSourceInventory.hasSymbol(identifier, aliases.performance, checker)
      );
    }
    if (expected === "performanceNamespace") {
      return DaemonRawClockSourceInventory.hasSymbol(
        identifier,
        aliases.performanceNamespaces,
        checker,
      );
    }
    if (expected === "process") {
      return (
        DaemonRawClockSourceInventory.isGlobalIdentifier(identifier, "process", checker) ||
        DaemonRawClockSourceInventory.hasSymbol(identifier, aliases.processNamespaces, checker)
      );
    }
    return (
      expected === "hrtime" &&
      DaemonRawClockSourceInventory.hasSymbol(identifier, aliases.hrtime, checker)
    );
  }

  private static ownerValues(expected: ClockValue, memberName: string | undefined): ClockValue[] {
    if (expected === "date" && memberName === "Date") return ["global"];
    if (expected === "performance" && memberName === "performance") {
      return ["global", "performanceNamespace"];
    }
    if (expected === "process" && memberName === "process") return ["global"];
    if (expected === "hrtime" && memberName === "hrtime") return ["process"];
    if (expected === "now" && memberName === "now") return ["date", "performance"];
    if (expected === "bigint" && memberName === "bigint") return ["hrtime"];
    return [];
  }

  private static isClockMemberPath(
    source: ts.Expression,
    members: readonly string[],
    expected: ClockValue,
    aliases: RawClockAliases,
    checker: ts.TypeChecker,
    visitedSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    if (members.length === 0) {
      return DaemonRawClockSourceInventory.isClockValue(
        source,
        expected,
        aliases,
        checker,
        visitedSymbols,
      );
    }
    const memberName = members[members.length - 1];
    return DaemonRawClockSourceInventory.ownerValues(expected, memberName).some((ownerValue) =>
      DaemonRawClockSourceInventory.isClockMemberPath(
        source,
        members.slice(0, -1),
        ownerValue,
        aliases,
        checker,
        visitedSymbols,
      ),
    );
  }

  private static staticBindingAlias(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
  ): StaticBindingAlias | undefined {
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        DaemonRawClockSourceInventory.isConstVariable(declaration)
      ) {
        return { source: declaration.initializer, members: [] };
      }
      if (ts.isBindingElement(declaration)) {
        const alias = DaemonRawClockSourceInventory.bindingAlias(declaration, checker);
        if (alias !== undefined) return alias;
      }
    }
    return undefined;
  }

  private static bindingAlias(
    declaration: ts.BindingElement,
    checker: ts.TypeChecker,
  ): StaticBindingAlias | undefined {
    const members: string[] = [];
    let bindingElement = declaration;
    while (true) {
      if (bindingElement.dotDotDotToken !== undefined) return undefined;
      const memberNode = bindingElement.propertyName ?? bindingElement.name;
      const memberName = DaemonRawClockSourceInventory.staticPropertyName(memberNode, checker);
      if (memberName === undefined) return undefined;
      members.unshift(memberName);
      const bindingPattern = bindingElement.parent;
      if (!ts.isObjectBindingPattern(bindingPattern)) return undefined;
      const owner = bindingPattern.parent;
      if (ts.isVariableDeclaration(owner)) {
        if (
          owner.initializer === undefined ||
          !DaemonRawClockSourceInventory.isConstVariable(owner)
        ) {
          return undefined;
        }
        return { source: owner.initializer, members };
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

  private static staticPropertyName(node: ts.Node, checker: ts.TypeChecker): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) {
      return DaemonRawClockSourceInventory.staticString(node.expression, checker, new Set());
    }
    return undefined;
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
    const unwrapped = DaemonRawClockSourceInventory.unwrapExpression(expression);
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
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

  private static isMemberAccess(node: ts.Node): node is MemberAccessExpression {
    return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  }

  private static memberName(
    expression: MemberAccessExpression,
    checker: ts.TypeChecker,
  ): string | undefined {
    return ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : DaemonRawClockSourceInventory.staticString(
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
    const unwrapped = DaemonRawClockSourceInventory.unwrapExpression(expression);
    const literal = DaemonRawClockSourceInventory.literalText(unwrapped);
    if (literal !== undefined) return literal;
    if (!ts.isIdentifier(unwrapped)) return undefined;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol === undefined || visitedSymbols.has(symbol)) return undefined;
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.initializer !== undefined &&
        DaemonRawClockSourceInventory.isConstVariable(candidate),
    );
    if (declaration?.initializer === undefined) return undefined;
    const nextVisitedSymbols = new Set(visitedSymbols);
    nextVisitedSymbols.add(symbol);
    return DaemonRawClockSourceInventory.staticString(
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
      return DaemonRawClockSourceInventory.unwrapExpression(expression.expression);
    }
    return expression;
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
