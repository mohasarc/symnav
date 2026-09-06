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
      if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue;
      if (!ts.isNamedExports(statement.exportClause)) {
        exports.push({ kind: "runtime", name: "*" });
        continue;
      }
      for (const element of statement.exportClause.elements) {
        exports.push({
          kind: statement.isTypeOnly || element.isTypeOnly ? "type" : "runtime",
          name: element.name.text,
        });
      }
    }
    return exports.sort((left, right) => left.name.localeCompare(right.name));
  }
}
