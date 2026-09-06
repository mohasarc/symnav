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
      "unprefixed named performance import",
      'import { performance as timer } from "perf_hooks"; timer.now();',
    ],
    [
      "unprefixed namespace performance import",
      'import * as hooks from "perf_hooks"; hooks.performance.now();',
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
      "unprefixed namespace process import",
      'import * as processModule from "process"; processModule.hrtime();',
    ],
    [
      "node-prefixed default process import",
      'import processModule from "node:process"; processModule.hrtime();',
    ],
  ])("recognizes %s as a raw clock source", (_name, source) => {
    expect(DaemonRawClockSourceInventory.hasRawClock(source)).toBe(true);
  });

  it.each([
    ["Date", "const Date = { now: () => 1 }; Date.now();"],
    ["performance", "const performance = { now: () => 1 }; performance.now();"],
    ["process", "const process = { hrtime: () => 1 }; process.hrtime();"],
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
  readonly performance: ReadonlySet<string>;
  readonly performanceNamespaces: ReadonlySet<string>;
  readonly hrtime: ReadonlySet<string>;
  readonly processNamespaces: ReadonlySet<string>;
}

class DaemonRawClockSourceInventory {
  static hasRawClock(sourceText: string): boolean {
    const sourceFile = ts.createSourceFile(
      "source.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const aliases = DaemonRawClockSourceInventory.clockAliases(sourceFile);
    return DaemonRawClockSourceInventory.containsRawClock(sourceFile, aliases);
  }

  private static clockAliases(sourceFile: ts.SourceFile): RawClockAliases {
    const performance = new Set<string>();
    const performanceNamespaces = new Set<string>();
    const hrtime = new Set<string>();
    const processNamespaces = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (statement.moduleSpecifier.text === "node:perf_hooks") {
        DaemonRawClockSourceInventory.collectImportAliases(
          bindings,
          "performance",
          performance,
          performanceNamespaces,
        );
      }
      if (statement.moduleSpecifier.text === "node:process") {
        DaemonRawClockSourceInventory.collectImportAliases(
          bindings,
          "hrtime",
          hrtime,
          processNamespaces,
        );
      }
    }
    return { performance, performanceNamespaces, hrtime, processNamespaces };
  }

  private static collectImportAliases(
    bindings: ts.NamedImportBindings | undefined,
    importedName: string,
    aliases: Set<string>,
    namespaces: Set<string>,
  ): void {
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        aliases.add(element.name.text);
      }
    }
  }

  private static containsRawClock(node: ts.Node, aliases: RawClockAliases): boolean {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (moduleName === "@symnav/telemetry" || moduleName.startsWith("@symnav/telemetry/")) {
        return true;
      }
    }
    if (
      ts.isNewExpression(node) &&
      DaemonRawClockSourceInventory.isGlobalMember(node.expression, "Date")
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      (DaemonRawClockSourceInventory.isGlobalMember(node.expression, "Date") ||
        (ts.isIdentifier(node.expression) && aliases.hrtime.has(node.expression.text)))
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      DaemonRawClockSourceInventory.isRawClockProperty(node, aliases)
    ) {
      return true;
    }
    return node
      .getChildren()
      .some((child) => DaemonRawClockSourceInventory.containsRawClock(child, aliases));
  }

  private static isRawClockProperty(
    expression: ts.PropertyAccessExpression,
    aliases: RawClockAliases,
  ): boolean {
    if (
      expression.name.text === "now" &&
      (DaemonRawClockSourceInventory.isGlobalMember(expression.expression, "Date") ||
        DaemonRawClockSourceInventory.isPerformance(expression.expression, aliases))
    ) {
      return true;
    }
    if (
      expression.name.text === "hrtime" &&
      DaemonRawClockSourceInventory.isProcess(expression.expression, aliases)
    ) {
      return true;
    }
    return (
      expression.name.text === "bigint" &&
      DaemonRawClockSourceInventory.isHrtime(expression.expression, aliases)
    );
  }

  private static isHrtime(expression: ts.Expression, aliases: RawClockAliases): boolean {
    if (ts.isIdentifier(expression)) return aliases.hrtime.has(expression.text);
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "hrtime" &&
      DaemonRawClockSourceInventory.isProcess(expression.expression, aliases)
    );
  }

  private static isPerformance(expression: ts.Expression, aliases: RawClockAliases): boolean {
    if (ts.isIdentifier(expression)) {
      return expression.text === "performance" || aliases.performance.has(expression.text);
    }
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "performance" &&
      (DaemonRawClockSourceInventory.isGlobalObject(expression.expression) ||
        (ts.isIdentifier(expression.expression) &&
          aliases.performanceNamespaces.has(expression.expression.text)))
    );
  }

  private static isProcess(expression: ts.Expression, aliases: RawClockAliases): boolean {
    if (ts.isIdentifier(expression)) {
      return expression.text === "process" || aliases.processNamespaces.has(expression.text);
    }
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "process" &&
      DaemonRawClockSourceInventory.isGlobalObject(expression.expression)
    );
  }

  private static isGlobalMember(expression: ts.Expression, member: string): boolean {
    return (
      (ts.isIdentifier(expression) && expression.text === member) ||
      (ts.isPropertyAccessExpression(expression) &&
        expression.name.text === member &&
        DaemonRawClockSourceInventory.isGlobalObject(expression.expression))
    );
  }

  private static isGlobalObject(expression: ts.Expression): boolean {
    return ts.isIdentifier(expression) && expression.text === "globalThis";
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
