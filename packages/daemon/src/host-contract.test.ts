import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";
import ts from "typescript";

import * as daemonRuntime from "./index.js";
import type {
  DaemonActivitySnapshot,
  DaemonCommandName,
  DaemonDiagnostics,
  DaemonDiagnosticValue,
  DaemonExecutionMode,
  DaemonExecutor,
  DaemonExecutorExecutionResult,
  DaemonExecutorFactory,
  DaemonExecutorFactoryOptions,
  DaemonExecutorInitializationResult,
  DaemonExecutorModule,
  DaemonExecutorModuleUrl,
  DaemonExecutorOutput,
  DaemonExecutorRequest,
  DaemonOutputRecord,
  DaemonOutputStream,
  DaemonStartResult,
  DaemonStatusEnvelope,
  DaemonStopResult,
  RunningDaemonStatus,
} from "./index.js";

type ExportKind = "runtime" | "type";

interface ExportedSymbol {
  readonly kind: ExportKind;
  readonly name: string;
}

interface DeclarationCompilation {
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly outputs: ReadonlyMap<string, string>;
}

class DaemonContractExpectation {
  public static readonly exports: readonly ExportedSymbol[] = [
    { kind: "type", name: "DaemonActivitySnapshot" },
    { kind: "type", name: "DaemonCommandName" },
    { kind: "type", name: "DaemonDiagnostics" },
    { kind: "type", name: "DaemonDiagnosticValue" },
    { kind: "type", name: "DaemonExecutionMode" },
    { kind: "type", name: "DaemonExecutor" },
    { kind: "type", name: "DaemonExecutorExecutionResult" },
    { kind: "type", name: "DaemonExecutorFactory" },
    { kind: "type", name: "DaemonExecutorFactoryOptions" },
    { kind: "type", name: "DaemonExecutorInitializationResult" },
    { kind: "type", name: "DaemonExecutorModule" },
    { kind: "type", name: "DaemonExecutorModuleUrl" },
    { kind: "type", name: "DaemonExecutorOutput" },
    { kind: "type", name: "DaemonExecutorRequest" },
    { kind: "type", name: "DaemonOutputRecord" },
    { kind: "type", name: "DaemonOutputStream" },
    { kind: "type", name: "DaemonStartResult" },
    { kind: "type", name: "DaemonStatusEnvelope" },
    { kind: "type", name: "DaemonStopResult" },
    { kind: "type", name: "RunningDaemonStatus" },
  ];

  public static readonly productionSources: readonly string[] = [
    "daemon-command-name.ts",
    "daemon-diagnostics.ts",
    "daemon-executor.ts",
    "daemon-lifecycle-report.ts",
    "index.ts",
  ];
}

class TypeScriptExportInventory {
  public static read(sourceText: string): readonly ExportedSymbol[] {
    const sourceFile = ts.createSourceFile(
      "index.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const exportedSymbols: ExportedSymbol[] = [];

    for (const statement of sourceFile.statements) {
      TypeScriptExportInventory.collect(statement, exportedSymbols);
    }

    return exportedSymbols.sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
    );
  }

  private static collect(statement: ts.Statement, output: ExportedSymbol[]): void {
    if (ts.isExportDeclaration(statement)) {
      TypeScriptExportInventory.collectExportDeclaration(statement, output);
      return;
    }

    if (ts.isExportAssignment(statement)) {
      output.push({ kind: "runtime", name: "default" });
      return;
    }

    if (!TypeScriptExportInventory.hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      return;
    }

    const isDefault = TypeScriptExportInventory.hasModifier(
      statement,
      ts.SyntaxKind.DefaultKeyword,
    );
    if (isDefault) {
      output.push({ kind: "runtime", name: "default" });
      return;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        TypeScriptExportInventory.collectBindingNames(declaration.name, output);
      }
      return;
    }

    const name = TypeScriptExportInventory.declarationName(statement);
    if (name === undefined) {
      return;
    }
    const kind =
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        ? "type"
        : "runtime";
    output.push({ kind, name });
  }

  private static collectExportDeclaration(
    declaration: ts.ExportDeclaration,
    output: ExportedSymbol[],
  ): void {
    if (declaration.exportClause === undefined) {
      output.push({ kind: declaration.isTypeOnly ? "type" : "runtime", name: "*" });
      return;
    }
    if (!ts.isNamedExports(declaration.exportClause)) {
      output.push({ kind: "runtime", name: declaration.exportClause.name.text });
      return;
    }
    for (const element of declaration.exportClause.elements) {
      output.push({
        kind: declaration.isTypeOnly || element.isTypeOnly ? "type" : "runtime",
        name: element.name.text,
      });
    }
  }

  private static collectBindingNames(bindingName: ts.BindingName, output: ExportedSymbol[]): void {
    if (ts.isIdentifier(bindingName)) {
      output.push({ kind: "runtime", name: bindingName.text });
      return;
    }
    for (const element of bindingName.elements) {
      if (!ts.isOmittedExpression(element)) {
        TypeScriptExportInventory.collectBindingNames(element.name, output);
      }
    }
  }

  private static declarationName(statement: ts.Statement): string | undefined {
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      return statement.name?.getText();
    }
    return undefined;
  }

  private static hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind) ?? false)
      : false;
  }
}

class DaemonProductionSourceInventory {
  public static read(sourceRoot: string): readonly string[] {
    return DaemonProductionSourceInventory.readDirectory(sourceRoot, sourceRoot).sort();
  }

  private static readDirectory(directory: string, sourceRoot: string): string[] {
    const paths: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        paths.push(...DaemonProductionSourceInventory.readDirectory(absolutePath, sourceRoot));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        paths.push(relative(sourceRoot, absolutePath).split(sep).join("/"));
      }
    }
    return paths;
  }
}

class NodeFreeDeclarationCompiler {
  public static compile(rootNames: readonly string[]): DeclarationCompilation {
    const outputs = new Map<string, string>();
    const program = ts.createProgram([...rootNames], {
      declaration: true,
      emitDeclarationOnly: true,
      exactOptionalPropertyTypes: true,
      lib: ["lib.es2022.d.ts"],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmitOnError: true,
      skipLibCheck: false,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    });
    const emitResult = program.emit(undefined, (fileName, data) => outputs.set(fileName, data));
    return {
      diagnostics: [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics],
      outputs,
    };
  }
}

describe("daemon host contract", () => {
  it("defines the exact portable execution contract", () => {
    expectTypeOf<DaemonExecutionMode>().toEqualTypeOf<"cold" | "warm" | "fallback">();
    expectTypeOf<DaemonOutputStream>().toEqualTypeOf<"stdout" | "stderr">();
    expectTypeOf<DaemonExecutorRequest>().toEqualTypeOf<{
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly telemetryEnabled: boolean;
      readonly executionMode: DaemonExecutionMode;
    }>();
    expectTypeOf<DaemonOutputRecord>().toEqualTypeOf<{
      readonly stream: DaemonOutputStream;
      readonly bytes: Uint8Array;
    }>();
    expectTypeOf<DaemonExecutorOutput>().toEqualTypeOf<{
      records(): AsyncIterable<DaemonOutputRecord>;
      dispose(): Promise<void>;
    }>();
    expectTypeOf<DaemonExecutorInitializationResult>().toEqualTypeOf<{
      readonly fileCount: number;
      readonly diagnostics?: DaemonDiagnostics;
    }>();
    expectTypeOf<DaemonExecutorExecutionResult>().toEqualTypeOf<{
      readonly exitCode: number;
      readonly output: DaemonExecutorOutput;
      readonly diagnostics?: DaemonDiagnostics;
    }>();
    expectTypeOf<DaemonExecutor>().toEqualTypeOf<{
      initialize(workspaceRoot: string): Promise<DaemonExecutorInitializationResult>;
      execute(request: DaemonExecutorRequest): Promise<DaemonExecutorExecutionResult>;
      releaseTransientResources(): Promise<void>;
    }>();
    expectTypeOf<DaemonExecutorFactoryOptions>().toEqualTypeOf<{
      readonly stateDirectory: string;
      readonly productVersion: string;
    }>();
    expectTypeOf<DaemonExecutorFactory>().toEqualTypeOf<
      (options: DaemonExecutorFactoryOptions) => DaemonExecutor | Promise<DaemonExecutor>
    >();
    expectTypeOf<DaemonExecutorModule>().toEqualTypeOf<{
      readonly createDaemonExecutor: DaemonExecutorFactory;
    }>();
    expectTypeOf<DaemonExecutorModuleUrl>().toEqualTypeOf<string>();
    expectTypeOf<DaemonDiagnosticValue>().toEqualTypeOf<
      | null
      | boolean
      | number
      | string
      | readonly DaemonDiagnosticValue[]
      | { readonly [key: string]: DaemonDiagnosticValue }
    >();
    expectTypeOf<DaemonDiagnostics>().toEqualTypeOf<
      Readonly<Record<string, DaemonDiagnosticValue>>
    >();
  });

  it("defines the exact lifecycle, activity, status, start, and stop shapes", () => {
    expectTypeOf<DaemonCommandName>().toEqualTypeOf<
      | "overview"
      | "resolve"
      | "def"
      | "refs"
      | "context"
      | "graph"
      | "stats"
      | "help"
      | "version"
      | "unknown"
    >();
    expectTypeOf<DaemonActivitySnapshot>().toEqualTypeOf<{
      readonly lifecycle: "starting" | "ready" | "busy" | "recovering" | "draining";
      readonly recoveryDetail?: "resource-pressure" | "worker-replacement";
      readonly pid: number;
      readonly startedAt: number;
      readonly startupElapsedMs: number;
      readonly fileCount?: number;
      readonly processRssBytes: number;
      readonly hardProcessRssBytes: number;
      readonly workerHeapUsedBytes?: number;
      readonly workerGeneration: number;
      readonly current?: {
        readonly requestId: string;
        readonly command: DaemonCommandName;
        readonly elapsedMs: number;
      };
      readonly queued: number;
      readonly lastCompletedAgoMs?: number;
      readonly spoolBytes: number;
    }>();
    expectTypeOf<RunningDaemonStatus>().toEqualTypeOf<
      | {
          readonly state: "starting";
          readonly workspaceRoot: string;
          readonly pid: number;
          readonly startupElapsedMs: number;
          readonly memoryBytes?: number;
        }
      | {
          readonly state: "ready";
          readonly workspaceRoot: string;
          readonly pid: number;
          readonly uptimeMs: number;
          readonly fileCount: number;
          readonly memoryBytes: number;
          readonly lastRequestAgoMs?: number;
        }
      | {
          readonly state: "busy";
          readonly workspaceRoot: string;
          readonly pid: number;
          readonly uptimeMs: number;
          readonly command: DaemonCommandName;
          readonly elapsedMs: number;
          readonly queued: number;
          readonly memoryBytes: number;
        }
      | {
          readonly state: "recovering";
          readonly workspaceRoot: string;
          readonly pid: number;
          readonly uptimeMs: number;
          readonly detail: "resource-pressure" | "worker-replacement" | "draining";
          readonly queued: number;
          readonly memoryBytes: number;
        }
      | {
          readonly state: "unresponsive";
          readonly workspaceRoot: string;
          readonly pid: number;
          readonly uptimeMs: number;
          readonly lastResponseAgoMs?: number;
          readonly lastKnown?: DaemonActivitySnapshot;
        }
    >();
    expectTypeOf<DaemonStatusEnvelope>().toEqualTypeOf<{
      readonly schemaVersion: 1;
      readonly daemons: readonly RunningDaemonStatus[];
    }>();
    expectTypeOf<DaemonStartResult>().toEqualTypeOf<
      | {
          readonly status: "ready";
          readonly workspaceRoot: string;
          readonly fileCount: number;
          readonly loadDurationMs: number;
        }
      | {
          readonly status: "already-running";
          readonly workspaceRoot: string;
          readonly pid: number;
          readonly uptimeMs: number;
        }
      | { readonly status: "disabled" }
    >();
    expectTypeOf<DaemonStopResult>().toEqualTypeOf<
      | { readonly status: "stopped"; readonly workspaceRoot: string; readonly pid: number }
      | { readonly status: "killed"; readonly workspaceRoot: string; readonly pid: number }
      | { readonly status: "not-running"; readonly workspaceRoot: string }
    >();
  });

  it("detects every TypeScript export form used to widen a barrel", () => {
    const source = `
      export const runtimeValue = 1;
      export function runtimeFunction() {}
      export class RuntimeClass {}
      export default class DefaultClass {}
      export interface PublicInterface {}
      export type PublicType = string;
      const local = 1; type LocalType = string;
      export { local as renamed, type LocalType as RenamedType };
      export type { ExternalType } from "external";
      export * from "wildcard";
    `;
    expect(TypeScriptExportInventory.read(source)).toEqual([
      { kind: "runtime", name: "*" },
      { kind: "runtime", name: "default" },
      { kind: "runtime", name: "renamed" },
      { kind: "runtime", name: "RuntimeClass" },
      { kind: "runtime", name: "runtimeFunction" },
      { kind: "runtime", name: "runtimeValue" },
      { kind: "type", name: "ExternalType" },
      { kind: "type", name: "PublicInterface" },
      { kind: "type", name: "PublicType" },
      { kind: "type", name: "RenamedType" },
    ]);
  });

  it("exports exactly the planned types and no runtime values", () => {
    const sourceRoot = dirname(new URL(import.meta.url).pathname);
    const indexSource = ts.sys.readFile(join(sourceRoot, "index.ts"));
    expect(indexSource).toBeDefined();
    expect(TypeScriptExportInventory.read(indexSource ?? "")).toEqual(
      DaemonContractExpectation.exports,
    );
    expect(Object.keys(daemonRuntime)).toEqual([]);
  });

  it("contains only the recursively allowlisted Phase 7 production sources", () => {
    const sourceRoot = dirname(new URL(import.meta.url).pathname);
    expect(DaemonProductionSourceInventory.read(sourceRoot)).toEqual(
      DaemonContractExpectation.productionSources,
    );
  });

  it("emits the exact declaration surface without Node ambient types", () => {
    const sourceRoot = dirname(new URL(import.meta.url).pathname);
    const compilation = NodeFreeDeclarationCompiler.compile([join(sourceRoot, "index.ts")]);
    expect(compilation.diagnostics).toEqual([]);
    const emittedIndex = [...compilation.outputs].find(([path]) => path.endsWith("/index.d.ts"));
    expect(emittedIndex).toBeDefined();
    expect(TypeScriptExportInventory.read(emittedIndex?.[1] ?? "")).toEqual(
      DaemonContractExpectation.exports,
    );
  });

  it("proves the Node-free compiler rejects a Buffer leak", () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-contract-"));
    const fixturePath = join(fixtureDirectory, "buffer-leak.ts");
    try {
      writeFileSync(fixturePath, "export type BufferLeak = Buffer;\n");
      const compilation = NodeFreeDeclarationCompiler.compile([fixturePath]);
      const messages = compilation.diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
      expect(messages.some((message) => message.includes("Cannot find name 'Buffer'"))).toBe(true);
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });
});
