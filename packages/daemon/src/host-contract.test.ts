import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";
import ts from "typescript";

import * as daemonRuntime from "./index.js";
import * as policyTestingRuntime from "./policy-testing.js";
import type {
  DaemonActivitySnapshot,
  AcceptedRequestCompatibility,
  DaemonAdmissionContext,
  DaemonAdmissionDecision,
  DaemonAdmissionGuard,
  DaemonAdmissionRejectionCode,
  DaemonCommandName,
  DaemonExecuteRejectionCode,
  DaemonExecutionCoordinates,
  DaemonDiagnostics,
  DaemonDiagnosticValue,
  DaemonExecutionFailureCode,
  DaemonExecutionFailureContext,
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
  DaemonOutputSink,
  DaemonOutputStream,
  DaemonSequencedOutputRecord,
  DaemonPolicyValues,
  DaemonReadinessProbe,
  DaemonSystemMemory,
  DaemonWorkerFailureCode,
  DaemonRejectedExecutionFrame,
  DaemonStartResult,
  DaemonStatusEnvelope,
  DaemonStopResult,
  RunningDaemonStatus,
  WorkspaceRequestQueueState,
} from "./index.js";
import {
  DAEMON_COMMAND_NAMES,
  DaemonAdmissionPolicy,
  DaemonAdmissionRejections,
  DaemonDiagnosticValues,
  DaemonExecutorModuleLoader,
  DaemonExecutionFailures,
  DaemonPolicy,
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

class DaemonContractSourcePath {
  public static root(moduleUrl: string): string {
    return dirname(fileURLToPath(moduleUrl));
  }
}

class DaemonContractExpectation {
  public static readonly exports: readonly ExportedSymbol[] = [
    { kind: "runtime", name: "DAEMON_COMMAND_NAMES" },
    { kind: "runtime", name: "DaemonAdmissionPolicy" },
    { kind: "runtime", name: "DaemonAdmissionRejections" },
    { kind: "runtime", name: "DaemonDiagnosticValues" },
    { kind: "runtime", name: "DaemonExecutionFailures" },
    { kind: "runtime", name: "DaemonExecutorModuleLoader" },
    { kind: "runtime", name: "DaemonPolicy" },
    { kind: "type", name: "AcceptedRequestCompatibility" },
    { kind: "type", name: "DaemonActivitySnapshot" },
    { kind: "type", name: "DaemonAdmissionContext" },
    { kind: "type", name: "DaemonAdmissionDecision" },
    { kind: "type", name: "DaemonAdmissionGuard" },
    { kind: "type", name: "DaemonAdmissionRejectionCode" },
    { kind: "type", name: "DaemonCommandName" },
    { kind: "type", name: "DaemonDiagnostics" },
    { kind: "type", name: "DaemonDiagnosticValue" },
    { kind: "type", name: "DaemonExecuteRejectionCode" },
    { kind: "type", name: "DaemonExecutionCoordinates" },
    { kind: "type", name: "DaemonExecutionFailureCode" },
    { kind: "type", name: "DaemonExecutionFailureContext" },
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
    { kind: "type", name: "DaemonOutputSink" },
    { kind: "type", name: "DaemonOutputStream" },
    { kind: "type", name: "DaemonPolicyValues" },
    { kind: "type", name: "DaemonReadinessProbe" },
    { kind: "type", name: "DaemonRejectedExecutionFrame" },
    { kind: "type", name: "DaemonSequencedOutputRecord" },
    { kind: "type", name: "DaemonStartResult" },
    { kind: "type", name: "DaemonStatusEnvelope" },
    { kind: "type", name: "DaemonStopResult" },
    { kind: "type", name: "DaemonSystemMemory" },
    { kind: "type", name: "DaemonWorkerFailureCode" },
    { kind: "type", name: "RunningDaemonStatus" },
    { kind: "type", name: "WorkspaceRequestQueueState" },
  ];

  public static readonly policyMembers = [
    "instance:toSerialized",
    "instance:values",
    "static:currentSystem",
    "static:fromSerialized",
    "static:fromSystemMemory",
  ];

  public static readonly commandNameMembers = ["static:is", "static:parse"];

  public static readonly executionFailureMembers = ["static:classify", "static:isCode"];

  public static readonly admissionPolicyMembers = ["instance:decide"];

  public static readonly admissionRejectionMembers = [
    "static:assertConsistent",
    "static:frame",
    "static:retrySafe",
  ];

  public static readonly policyTestingExports: readonly ExportedSymbol[] = [
    { kind: "runtime", name: "DaemonPolicyTestFactory" },
  ];

  public static readonly productionSources: readonly string[] = [
    "daemon-admission.ts",
    "daemon-command-name.ts",
    "daemon-diagnostics.ts",
    "daemon-execution-failure.ts",
    "daemon-executor.ts",
    "daemon-lifecycle-report.ts",
    "daemon-policy.ts",
    "index.ts",
    "policy-testing.ts",
  ];
}

class TypeScriptClassMemberInventory {
  public static read(sourceText: string, className: string): readonly string[] {
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
      .filter(
        (member) =>
          !TypeScriptClassMemberInventory.hasModifier(member, ts.SyntaxKind.PrivateKeyword),
      )
      .flatMap((member) => {
        if (ts.isConstructorDeclaration(member) || member.name === undefined) return [];
        const scope = TypeScriptClassMemberInventory.hasModifier(
          member,
          ts.SyntaxKind.StaticKeyword,
        )
          ? "static"
          : "instance";
        return [`${scope}:${member.name.getText(sourceFile)}`];
      })
      .sort();
  }

  private static hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node)
      ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
      : false;
  }
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

    if (ts.isImportEqualsDeclaration(statement)) {
      output.push({ kind: statement.isTypeOnly ? "type" : "runtime", name: statement.name.text });
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
  it("decodes source module URLs before filesystem access", () => {
    const sourcePath = join(tmpdir(), "symnav contract path", "host-contract.test.ts");
    expect(DaemonContractSourcePath.root(pathToFileURL(sourcePath).href)).toBe(dirname(sourcePath));
  });

  it("defines the exact admission authority", () => {
    expectTypeOf<DaemonExecuteRejectionCode>().toEqualTypeOf<
      "not-ready" | "draining" | "resource-pressure" | "incompatible"
    >();
    expectTypeOf<DaemonExecutionCoordinates>().toEqualTypeOf<{
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
    }>();
    expectTypeOf<DaemonRejectedExecutionFrame>().toEqualTypeOf<{
      readonly kind: "rejected";
      readonly instanceId: string;
      readonly processToken: string;
      readonly requestId: string;
      readonly code: DaemonExecuteRejectionCode;
      readonly retrySafe: boolean;
    }>();
    expectTypeOf<DaemonAdmissionContext>().toEqualTypeOf<{
      readonly request: unknown;
      readonly authenticated: boolean;
      readonly workerReady: boolean;
      readonly resourceAdmissionPaused: boolean;
      readonly queueState: WorkspaceRequestQueueState;
      readonly compatibility: AcceptedRequestCompatibility;
    }>();

    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const source = ts.sys.readFile(join(sourceRoot, "daemon-admission.ts"));
    expect(source).toBeDefined();
    expect(TypeScriptClassMemberInventory.read(source ?? "", "DaemonAdmissionPolicy")).toEqual(
      DaemonContractExpectation.admissionPolicyMembers,
    );
    expect(TypeScriptClassMemberInventory.read(source ?? "", "DaemonAdmissionRejections")).toEqual(
      DaemonContractExpectation.admissionRejectionMembers,
    );
  });

  it("defines the exact execution failure contract", () => {
    expectTypeOf<DaemonExecutionFailureCode>().toEqualTypeOf<
      "worker-exit" | "controlled-resource" | "response-capacity" | "stopping" | "internal"
    >();
    expectTypeOf<DaemonWorkerFailureCode>().toEqualTypeOf<
      "initialization" | "execution" | "protocol" | "resource"
    >();
    expectTypeOf<DaemonExecutionFailureContext>().toEqualTypeOf<{
      readonly resourceInterrupted: boolean;
      readonly responseCapacityExceeded: boolean;
      readonly workerExited: boolean;
      readonly shutdownFailureCode?: "stopping" | "controlled-resource";
      readonly shutdownStarted: boolean;
    }>();

    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const source = ts.sys.readFile(join(sourceRoot, "daemon-execution-failure.ts"));
    expect(source).toBeDefined();
    expect(TypeScriptClassMemberInventory.read(source ?? "", "DaemonExecutionFailures")).toEqual(
      DaemonContractExpectation.executionFailureMembers,
    );

    const compilation = NodeFreeDeclarationCompiler.compile([
      join(sourceRoot, "daemon-execution-failure.ts"),
    ]);
    expect(compilation.diagnostics).toEqual([]);
    const declaration = [...compilation.outputs].find(([path]) =>
      path.endsWith("/daemon-execution-failure.d.ts"),
    );
    expect(declaration).toBeDefined();
    expect(
      TypeScriptClassMemberInventory.read(declaration?.[1] ?? "", "DaemonExecutionFailures"),
    ).toEqual(DaemonContractExpectation.executionFailureMembers);
  });

  it("defines the exact command vocabulary and readiness probe", () => {
    expectTypeOf<typeof DAEMON_COMMAND_NAMES>().toEqualTypeOf<
      readonly [
        "overview",
        "resolve",
        "def",
        "refs",
        "context",
        "graph",
        "stats",
        "help",
        "version",
        "unknown",
      ]
    >();
    expectTypeOf<DaemonCommandName>().toEqualTypeOf<(typeof DAEMON_COMMAND_NAMES)[number]>();
    expectTypeOf<DaemonReadinessProbe>().toEqualTypeOf<{
      readonly commandName: DaemonCommandName;
      readonly argv: readonly string[];
    }>();

    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const commandNameSource = ts.sys.readFile(join(sourceRoot, "daemon-command-name.ts"));
    expect(commandNameSource).toBeDefined();
    expect(
      TypeScriptClassMemberInventory.read(commandNameSource ?? "", "DaemonCommandNames"),
    ).toEqual(DaemonContractExpectation.commandNameMembers);

    const compilation = NodeFreeDeclarationCompiler.compile([
      join(sourceRoot, "daemon-command-name.ts"),
    ]);
    expect(compilation.diagnostics).toEqual([]);
    const declaration = [...compilation.outputs].find(([path]) =>
      path.endsWith("/daemon-command-name.d.ts"),
    );
    expect(declaration).toBeDefined();
    expect(
      TypeScriptClassMemberInventory.read(declaration?.[1] ?? "", "DaemonCommandNames"),
    ).toEqual(DaemonContractExpectation.commandNameMembers);
  });

  it("defines the exact daemon policy static and instance API", () => {
    expectTypeOf<keyof typeof DaemonPolicy>().toEqualTypeOf<
      "prototype" | "currentSystem" | "fromSystemMemory" | "fromSerialized"
    >();
    expectTypeOf<DaemonPolicy>().toEqualTypeOf<{
      readonly values: DaemonPolicyValues;
      toSerialized(): Readonly<{
        readonly schemaVersion: 1;
        readonly values: DaemonPolicyValues;
      }>;
    }>();
    expectTypeOf<typeof DaemonPolicy.currentSystem>().returns.toEqualTypeOf<DaemonPolicy>();
    expectTypeOf<typeof DaemonPolicy.fromSystemMemory>().parameters.toEqualTypeOf<
      [DaemonSystemMemory]
    >();
    expectTypeOf<typeof DaemonPolicy.fromSerialized>().parameters.toEqualTypeOf<[unknown]>();

    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const policySource = ts.sys.readFile(join(sourceRoot, "daemon-policy.ts"));
    expect(policySource).toBeDefined();
    expect(TypeScriptClassMemberInventory.read(policySource ?? "", "DaemonPolicy")).toEqual(
      DaemonContractExpectation.policyMembers,
    );

    const compilation = NodeFreeDeclarationCompiler.compile([join(sourceRoot, "daemon-policy.ts")]);
    expect(compilation.diagnostics).toEqual([]);
    const declaration = [...compilation.outputs].find(([path]) =>
      path.endsWith("/daemon-policy.d.ts"),
    );
    expect(declaration).toBeDefined();
    expect(TypeScriptClassMemberInventory.read(declaration?.[1] ?? "", "DaemonPolicy")).toEqual(
      DaemonContractExpectation.policyMembers,
    );
  });

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
    expectTypeOf<DaemonSequencedOutputRecord>().toEqualTypeOf<{
      readonly sequence: number;
      readonly stream: DaemonOutputStream;
      readonly bytes: Uint8Array;
    }>();
    expectTypeOf<DaemonOutputSink>().toEqualTypeOf<{
      append(record: DaemonSequencedOutputRecord): Promise<void>;
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
      readonly sampleResources: () => void;
    }>();
    expectTypeOf<DaemonExecutorFactory>().toEqualTypeOf<
      (options: DaemonExecutorFactoryOptions) => DaemonExecutor | Promise<DaemonExecutor>
    >();
    expectTypeOf<DaemonExecutorModule>().toEqualTypeOf<{
      readonly createDaemonExecutor: DaemonExecutorFactory;
    }>();
    expectTypeOf<DaemonExecutorModuleUrl>().toEqualTypeOf<string>();
    expectTypeOf<typeof DaemonExecutorModuleLoader.load>().parameters.toEqualTypeOf<
      [DaemonExecutorModuleUrl, DaemonExecutorFactoryOptions]
    >();
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
    expect(
      DaemonDiagnosticValues.isDiagnostics({
        text: "opaque",
        nested: { list: [null, true, 1, "value"] },
      }),
    ).toBe(true);
    expect(DaemonDiagnosticValues.isDiagnostics({ nested: { invalid: undefined } })).toBe(false);
    expect(DaemonDiagnosticValues.isDiagnostics({ invalid: Number.POSITIVE_INFINITY })).toBe(false);
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
      export import type ImportEqualsType = require("external");
    `;
    expect(TypeScriptExportInventory.read(source)).toEqual([
      { kind: "runtime", name: "*" },
      { kind: "runtime", name: "default" },
      { kind: "runtime", name: "renamed" },
      { kind: "runtime", name: "RuntimeClass" },
      { kind: "runtime", name: "runtimeFunction" },
      { kind: "runtime", name: "runtimeValue" },
      { kind: "type", name: "ExternalType" },
      { kind: "type", name: "ImportEqualsType" },
      { kind: "type", name: "PublicInterface" },
      { kind: "type", name: "PublicType" },
      { kind: "type", name: "RenamedType" },
    ]);
  });

  it("exports exactly the planned root types and runtime values", () => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const indexSource = ts.sys.readFile(join(sourceRoot, "index.ts"));
    expect(indexSource).toBeDefined();
    expect(TypeScriptExportInventory.read(indexSource ?? "")).toEqual(
      DaemonContractExpectation.exports,
    );
    expect(Object.keys(daemonRuntime)).toEqual([
      "DaemonAdmissionPolicy",
      "DaemonAdmissionRejections",
      "DAEMON_COMMAND_NAMES",
      "DaemonDiagnosticValues",
      "DaemonExecutionFailures",
      "DaemonExecutorModuleLoader",
      "DaemonPolicy",
    ]);
  });

  it("detects a public member added to DaemonPolicy", () => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const policySource = ts.sys.readFile(join(sourceRoot, "daemon-policy.ts")) ?? "";
    const mutatedSource = policySource.replace(
      "export class DaemonPolicy {",
      "export class DaemonPolicy { public static withOverrides(): void {}",
    );
    expect(TypeScriptClassMemberInventory.read(mutatedSource, "DaemonPolicy")).not.toEqual(
      DaemonContractExpectation.policyMembers,
    );
  });

  it("exports exactly one policy-testing source and runtime symbol", () => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const source = ts.sys.readFile(join(sourceRoot, "policy-testing.ts"));
    expect(source).toBeDefined();
    expect(TypeScriptExportInventory.read(source ?? "")).toEqual(
      DaemonContractExpectation.policyTestingExports,
    );
    expect(Object.keys(policyTestingRuntime)).toEqual(["DaemonPolicyTestFactory"]);
  });

  it.each([
    ["type", "export interface ExtraPolicyTestingType {}"],
    ["runtime", "export const extraPolicyTestingRuntime = true;"],
  ])("detects an extra policy-testing %s export", (_, addition) => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const source = ts.sys.readFile(join(sourceRoot, "policy-testing.ts")) ?? "";
    expect(TypeScriptExportInventory.read(`${source}\n${addition}\n`)).not.toEqual(
      DaemonContractExpectation.policyTestingExports,
    );
  });

  it("contains only the recursively allowlisted Phase 7 production sources", () => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    expect(DaemonProductionSourceInventory.read(sourceRoot)).toEqual(
      DaemonContractExpectation.productionSources,
    );
  });

  it("emits the exact declaration surface without Node ambient types", () => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const compilation = NodeFreeDeclarationCompiler.compile([join(sourceRoot, "index.ts")]);
    expect(compilation.diagnostics).toEqual([]);
    const emittedIndex = [...compilation.outputs].find(([path]) => path.endsWith("/index.d.ts"));
    expect(emittedIndex).toBeDefined();
    expect(TypeScriptExportInventory.read(emittedIndex?.[1] ?? "")).toEqual(
      DaemonContractExpectation.exports,
    );
  });

  it("emits only the policy test factory from the temporary subpath", () => {
    const sourceRoot = DaemonContractSourcePath.root(import.meta.url);
    const compilation = NodeFreeDeclarationCompiler.compile([
      join(sourceRoot, "policy-testing.ts"),
    ]);
    expect(compilation.diagnostics).toEqual([]);
    const declaration = [...compilation.outputs].find(([path]) =>
      path.endsWith("/policy-testing.d.ts"),
    );
    expect(declaration).toBeDefined();
    expect(TypeScriptExportInventory.read(declaration?.[1] ?? "")).toEqual(
      DaemonContractExpectation.policyTestingExports,
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
