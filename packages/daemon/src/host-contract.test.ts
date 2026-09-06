import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as daemonRuntime from "./index.js";
import { DaemonPolicy } from "./index.js";

const runtimeExports = ["DAEMON_COMMAND_NAMES", "DaemonClient", "DaemonPolicy"];
const typeExports = [
  "DaemonActivitySnapshot",
  "DaemonClientExecuteRequest",
  "DaemonClientExecuteResult",
  "DaemonClientOptions",
  "DaemonCommandName",
  "DaemonControlRequest",
  "DaemonDiagnostics",
  "DaemonDiagnosticValue",
  "DaemonExecutionMode",
  "DaemonExecutor",
  "DaemonExecutorExecutionResult",
  "DaemonExecutorFactory",
  "DaemonExecutorFactoryOptions",
  "DaemonExecutorInitializationResult",
  "DaemonExecutorModule",
  "DaemonExecutorModuleUrl",
  "DaemonExecutorOutput",
  "DaemonExecutorRequest",
  "DaemonOutputRecord",
  "DaemonOutputStream",
  "DaemonPolicyValues",
  "DaemonReadinessProbe",
  "DaemonStartResult",
  "DaemonStatusEnvelope",
  "DaemonStopResult",
  "DaemonSystemMemory",
  "RunningDaemonStatus",
];

describe("daemon host contract", () => {
  it("inventories every TypeScript export declaration form", () => {
    const exports = TypeScriptExportInventory.read(`
      export interface LocalInterface {}
      export type LocalType = string;
      export class LocalClass {}
      export function localFunction() {}
      export const localValue = true, secondLocalValue = false;
      export enum LocalEnum { Value }
      export namespace LocalNamespace {}
      type NamedType = string;
      const namedValue = true;
      export { namedValue as NamedValue, type NamedType };
      export type { ExternalType } from "./external.js";
      export * from "./runtime.js";
      export type * from "./types.js";
      export default localFunction;
    `);

    expect(exports).toEqual([
      { kind: "runtime", name: "*" },
      { kind: "type", name: "*" },
      { kind: "runtime", name: "default" },
      { kind: "type", name: "ExternalType" },
      { kind: "runtime", name: "LocalClass" },
      { kind: "runtime", name: "LocalEnum" },
      { kind: "runtime", name: "localFunction" },
      { kind: "type", name: "LocalInterface" },
      { kind: "runtime", name: "LocalNamespace" },
      { kind: "type", name: "LocalType" },
      { kind: "runtime", name: "localValue" },
      { kind: "type", name: "NamedType" },
      { kind: "runtime", name: "NamedValue" },
      { kind: "runtime", name: "secondLocalValue" },
    ]);
  });

  it("exports the exact root runtime and type allowlists", () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(sourceRoot, "index.ts"), "utf8");
    const exports = TypeScriptExportInventory.read(source);

    expect(Object.keys(daemonRuntime).sort()).toEqual(runtimeExports);
    expect(exports.filter((entry) => entry.kind === "runtime").map((entry) => entry.name)).toEqual(
      runtimeExports,
    );
    expect(exports.filter((entry) => entry.kind === "type").map((entry) => entry.name)).toEqual(
      typeExports,
    );
  });

  it("keeps daemon policy construction host-only", () => {
    expect(DaemonPolicy.currentSystem).toBeTypeOf("function");
    expect(DaemonPolicy.fromSystemMemory).toBeTypeOf("function");
    expect(Object.getOwnPropertyNames(DaemonPolicy)).not.toContain("fromSerialized");
    expect(Object.getOwnPropertyNames(DaemonPolicy.prototype)).toEqual(["constructor"]);
    expect(DaemonPolicy.currentSystem()).toHaveProperty("values");
    expect(Object.getOwnPropertyNames(DaemonPolicy.prototype)).not.toContain("toSerialized");
  });

  it.each(["process-entry.ts", "worker-entry.ts"])("keeps %s export-free", (filename) => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(sourceRoot, filename), "utf8");
    expect(TypeScriptExportInventory.read(source)).toEqual([]);
  });
});

interface ExportedSymbol {
  readonly kind: "runtime" | "type";
  readonly name: string;
}

class TypeScriptExportInventory {
  static read(sourceText: string): readonly ExportedSymbol[] {
    const sourceFile = ts.createSourceFile(
      "source.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const exports: ExportedSymbol[] = [];
    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        exports.push(...TypeScriptExportInventory.exportDeclarationSymbols(statement));
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        exports.push({
          kind: "runtime",
          name: statement.isExportEquals ? "export=" : "default",
        });
        continue;
      }
      if (!TypeScriptExportInventory.hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      exports.push(...TypeScriptExportInventory.declarationSymbols(statement));
    }
    return exports.sort(
      (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind),
    );
  }

  private static exportDeclarationSymbols(
    statement: ts.ExportDeclaration,
  ): readonly ExportedSymbol[] {
    const declarationKind = statement.isTypeOnly ? "type" : "runtime";
    if (statement.exportClause === undefined) return [{ kind: declarationKind, name: "*" }];
    if (ts.isNamespaceExport(statement.exportClause)) {
      return [{ kind: declarationKind, name: statement.exportClause.name.text }];
    }
    return statement.exportClause.elements.map((element) => ({
      kind: statement.isTypeOnly || element.isTypeOnly ? "type" : "runtime",
      name: element.name.text,
    }));
  }

  private static declarationSymbols(statement: ts.Statement): readonly ExportedSymbol[] {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        TypeScriptExportInventory.bindingNames(declaration.name).map((name) => ({
          kind: "runtime" as const,
          name,
        })),
      );
    }
    const kind =
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        ? "type"
        : "runtime";
    const isDefault = TypeScriptExportInventory.hasModifier(
      statement,
      ts.SyntaxKind.DefaultKeyword,
    );
    if (isDefault) return [{ kind, name: "default" }];
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      return statement.name === undefined ? [] : [{ kind, name: statement.name.text }];
    }
    return [];
  }

  private static bindingNames(name: ts.BindingName): readonly string[] {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : TypeScriptExportInventory.bindingNames(element.name),
    );
  }

  private static hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((item) => item.kind === kind) ?? false)
    );
  }
}
