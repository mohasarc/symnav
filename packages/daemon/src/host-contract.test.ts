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
const testingRuntimeExports = ["DaemonTestingInspector"];
const testingTypeExports = [
  "DaemonTestingDiagnosticEvent",
  "DaemonTestingDiagnosticPage",
  "DaemonTestingInstance",
  "DaemonTestingSpoolUsage",
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
      declare namespace AliasNamespace { type Type = string }
      namespace RuntimeAliasNamespace { export const value = true }
      export import AliasRuntime = RuntimeAliasNamespace.value;
      export import AliasType = AliasNamespace.Type;
      export import ExternalAlias = require("./runtime.js");
      export as namespace GlobalAlias;
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
      { kind: "runtime", name: "AliasRuntime" },
      { kind: "type", name: "AliasType" },
      { kind: "runtime", name: "default" },
      { kind: "runtime", name: "ExternalAlias" },
      { kind: "type", name: "ExternalType" },
      { kind: "type", name: "GlobalAlias" },
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

  it("exports the exact root runtime allowlist", () => {
    expect(Object.keys(daemonRuntime).sort()).toEqual(runtimeExports);
  });

  it.each([
    ["root source", "index.ts", runtimeExports, typeExports],
    ["root declaration", "../dist/index.d.ts", runtimeExports, typeExports],
    ["testing source", "testing/index.ts", testingRuntimeExports, testingTypeExports],
    [
      "testing declaration",
      "../dist/testing/index.d.ts",
      testingRuntimeExports,
      testingTypeExports,
    ],
  ])("exports the exact %s allowlists", (_name, relativePath, runtime, types) => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(sourceRoot, relativePath), "utf8");
    const exports = TypeScriptExportInventory.read(source);

    expect(exports.filter((entry) => entry.kind === "runtime").map((entry) => entry.name)).toEqual(
      runtime,
    );
    expect(exports.filter((entry) => entry.kind === "type").map((entry) => entry.name)).toEqual(
      types,
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

  it("inventories public class members from emitted declarations", () => {
    expect(
      TypeScriptClassSurfaceInventory.read(
        `
          export declare class Example {
            readonly value: string;
            static create(): Example;
            execute(): void;
            get label(): string;
            private static hidden(): void;
            protected inherited(): void;
            private constructor();
          }
        `,
        "Example",
      ),
    ).toEqual([
      "constructor:private",
      "instance-getter:label",
      "instance-method:execute",
      "instance-property:value:readonly",
      "static-method:create",
    ]);
  });

  it("keeps the emitted DaemonPolicy class surface exact", () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const declaration = readFileSync(join(sourceRoot, "../dist/daemon-policy.d.ts"), "utf8");

    expect(TypeScriptClassSurfaceInventory.read(declaration, "DaemonPolicy")).toEqual([
      "constructor:private",
      "instance-property:values:readonly",
      "static-method:currentSystem",
      "static-method:fromSystemMemory",
    ]);
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
      if (ts.isNamespaceExportDeclaration(statement)) {
        exports.push({ kind: "type", name: statement.name.text });
        continue;
      }
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
    if (ts.isImportEqualsDeclaration(statement)) {
      const kind =
        statement.isTypeOnly || !ts.isExternalModuleReference(statement.moduleReference)
          ? "type"
          : "runtime";
      return [{ kind, name: statement.name.text }];
    }
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

class TypeScriptClassSurfaceInventory {
  static read(sourceText: string, className: string): readonly string[] {
    const sourceFile = ts.createSourceFile(
      "source.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declaration = sourceFile.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === className,
    );
    if (declaration === undefined) return [];
    return declaration.members
      .flatMap((member) => TypeScriptClassSurfaceInventory.memberSurface(member))
      .sort((left, right) => left.localeCompare(right));
  }

  private static memberSurface(member: ts.ClassElement): readonly string[] {
    if (ts.isConstructorDeclaration(member)) {
      return [`constructor:${TypeScriptClassSurfaceInventory.visibility(member)}`];
    }
    if (TypeScriptClassSurfaceInventory.visibility(member) !== "public") return [];
    const scope = TypeScriptClassSurfaceInventory.hasModifier(member, ts.SyntaxKind.StaticKeyword)
      ? "static"
      : "instance";
    if (ts.isIndexSignatureDeclaration(member)) return [`${scope}-index`];
    const name = TypeScriptClassSurfaceInventory.memberName(member.name);
    if (name === undefined) return [];
    if (ts.isPropertyDeclaration(member)) {
      const readonly = TypeScriptClassSurfaceInventory.hasModifier(
        member,
        ts.SyntaxKind.ReadonlyKeyword,
      )
        ? ":readonly"
        : "";
      return [`${scope}-property:${name}${readonly}`];
    }
    if (ts.isMethodDeclaration(member)) return [`${scope}-method:${name}`];
    if (ts.isGetAccessorDeclaration(member)) return [`${scope}-getter:${name}`];
    if (ts.isSetAccessorDeclaration(member)) return [`${scope}-setter:${name}`];
    return [];
  }

  private static memberName(name: ts.PropertyName | undefined): string | undefined {
    if (name === undefined) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) {
      return name.text;
    }
    if (ts.isNumericLiteral(name)) return name.text;
    return name.getText();
  }

  private static visibility(node: ts.Node): "public" | "protected" | "private" {
    if (TypeScriptClassSurfaceInventory.hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
      return "private";
    }
    return TypeScriptClassSurfaceInventory.hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
      ? "protected"
      : "public";
  }

  private static hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((item) => item.kind === kind) ?? false)
    );
  }
}
