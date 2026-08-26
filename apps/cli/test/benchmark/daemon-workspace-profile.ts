import type { DaemonCommandName } from "../../src/daemon/daemon-protocol.js";
import { createWorkspace, NodeFileSystem } from "@symnav/core";

export interface DistributionSummary {
  readonly minimum: number;
  readonly p50: number;
  readonly p95: number;
  readonly maximum: number;
}

export interface DaemonWorkspaceProfile {
  readonly schemaVersion: 1;
  readonly profileVersion: string;
  readonly visibleTypeScriptFiles: number;
  readonly sourceBytes: DistributionSummary;
  readonly sourceLines: DistributionSummary;
  readonly symbolsPerFile: DistributionSummary;
  readonly packageCount: number;
  readonly configCount: number;
  readonly projectReferenceCount: number;
  readonly importsPerFile: DistributionSummary;
  readonly referenceFanout: DistributionSummary;
  readonly aliasImportRatio: number;
  readonly workspaceImportRatio: number;
  readonly callInDegree: DistributionSummary;
  readonly callOutDegree: DistributionSummary;
  readonly callDepth: DistributionSummary;
  readonly cycleRatio: number;
  readonly declarationKindCounts: Readonly<Record<string, number>>;
  readonly representativeResultCounts: Readonly<Record<DaemonCommandName, number>>;
  readonly ignoredPathRatio: number;
  readonly nestedWorkspaceRatio: number;
}

export class DaemonWorkspaceProfileValidator {
  private static readonly fields = [
    "schemaVersion",
    "profileVersion",
    "visibleTypeScriptFiles",
    "sourceBytes",
    "sourceLines",
    "symbolsPerFile",
    "packageCount",
    "configCount",
    "projectReferenceCount",
    "importsPerFile",
    "referenceFanout",
    "aliasImportRatio",
    "workspaceImportRatio",
    "callInDegree",
    "callOutDegree",
    "callDepth",
    "cycleRatio",
    "declarationKindCounts",
    "representativeResultCounts",
    "ignoredPathRatio",
    "nestedWorkspaceRatio",
  ] as const;

  private static readonly distributionFields = ["minimum", "p50", "p95", "maximum"] as const;
  private static readonly commandNames: readonly DaemonCommandName[] = [
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
  ];

  static parse(value: unknown): DaemonWorkspaceProfile {
    if (!this.hasExactFields(value, this.fields)) throw new Error("Invalid daemon profile fields");
    if (value.schemaVersion !== 1) throw new Error("Invalid daemon profile schema version");
    if (typeof value.profileVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.profileVersion)) {
      throw new Error("Invalid daemon profile version");
    }
    for (const field of [
      "visibleTypeScriptFiles",
      "packageCount",
      "configCount",
      "projectReferenceCount",
    ] as const) {
      this.assertCount(value[field], field);
    }
    for (const field of [
      "sourceBytes",
      "sourceLines",
      "symbolsPerFile",
      "importsPerFile",
      "referenceFanout",
      "callInDegree",
      "callOutDegree",
      "callDepth",
    ] as const) {
      this.assertDistribution(value[field]);
    }
    for (const field of [
      "aliasImportRatio",
      "workspaceImportRatio",
      "cycleRatio",
      "ignoredPathRatio",
      "nestedWorkspaceRatio",
    ] as const) {
      this.assertRatio(value[field], field);
    }
    this.assertCountRecord(value.declarationKindCounts, "declaration kind counts");
    if (!this.hasExactFields(value.representativeResultCounts, this.commandNames)) {
      throw new Error("Invalid representative result fields");
    }
    this.assertCountRecord(value.representativeResultCounts, "representative result counts");
    return value as unknown as DaemonWorkspaceProfile;
  }

  private static assertDistribution(value: unknown): asserts value is DistributionSummary {
    if (!this.hasExactFields(value, this.distributionFields)) {
      throw new Error("Invalid daemon profile distribution fields");
    }
    const ordered = [value.minimum, value.p50, value.p95, value.maximum];
    if (ordered.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
      throw new Error("Invalid daemon profile distribution order");
    }
    const numericOrder = ordered as number[];
    if (numericOrder.some((item, index) => index > 0 && item < numericOrder[index - 1]!)) {
      throw new Error("Invalid daemon profile distribution order");
    }
  }

  private static assertRatio(value: unknown, field: string): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid daemon profile ${field}`);
    }
  }

  private static assertCount(value: unknown, field: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Invalid daemon profile ${field}`);
    }
  }

  private static assertCountRecord(value: unknown, field: string): void {
    if (!this.isRecord(value) || Object.keys(value).length === 0) {
      throw new Error(`Invalid daemon profile ${field}`);
    }
    for (const count of Object.values(value)) this.assertCount(count, field);
  }

  private static hasExactFields(
    value: unknown,
    fields: readonly string[],
  ): value is Record<string, unknown> {
    if (!this.isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    return (
      actual.length === expected.length && actual.every((field, index) => field === expected[index])
    );
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class DaemonWorkspaceProfiler {
  async profile(workspaceRoot: string): Promise<DaemonWorkspaceProfile> {
    const fileSystem = new NodeFileSystem();
    const workspace = await createWorkspace({ startDir: workspaceRoot, fs: fileSystem });
    const files = await workspace.enumerate();
    const typeScriptFiles = files.filter((file) => /\.tsx?$/.test(file.relative));
    const sourceBytes: number[] = [];
    const sourceLines: number[] = [];
    const symbolsPerFile: number[] = [];
    const importsPerFile: number[] = [];
    const referenceFanout: number[] = [];
    const callOutDegree: number[] = [];
    const callDepth: number[] = [];
    const declarationKindCounts: Record<string, number> = {};
    let importCount = 0;
    let aliasImportCount = 0;
    let workspaceImportCount = 0;

    for (const file of typeScriptFiles) {
      const source = await fileSystem.readFile(file.absolute);
      const declarations = [
        ...source.matchAll(/\b(class|function|interface|type|enum|const|let|var)\s+\w+/g),
      ];
      const imports = [
        ...source.matchAll(
          /\b(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g,
        ),
      ];
      const calls = [...source.matchAll(/\b[A-Za-z_$][\w$]*\s*\(/g)].length;
      sourceBytes.push(Buffer.byteLength(source));
      sourceLines.push(
        source.length === 0 ? 0 : source.split("\n").length - Number(source.endsWith("\n")),
      );
      symbolsPerFile.push(declarations.length);
      importsPerFile.push(imports.length);
      referenceFanout.push(Math.max(0, declarations.length - 1));
      callOutDegree.push(calls);
      callDepth.push(DaemonWorkspaceProfiler.maximumBraceDepth(source));
      for (const declaration of declarations) {
        const kind = declaration[1] ?? "unknown";
        declarationKindCounts[kind] = (declarationKindCounts[kind] ?? 0) + 1;
      }
      for (const imported of imports) {
        const specifier = imported[1] ?? imported[2] ?? "";
        importCount += 1;
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) aliasImportCount += 1;
        if (specifier.startsWith("@workspace/")) workspaceImportCount += 1;
      }
    }

    const configFiles = files.filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/.test(file.relative));
    let projectReferenceCount = 0;
    for (const config of configFiles) {
      try {
        const parsed = JSON.parse(await fileSystem.readFile(config.absolute)) as {
          readonly references?: readonly unknown[];
        };
        projectReferenceCount += Array.isArray(parsed.references) ? parsed.references.length : 0;
      } catch {}
    }

    return DaemonWorkspaceProfileValidator.parse({
      schemaVersion: 1,
      profileVersion: "1.0.0",
      visibleTypeScriptFiles: typeScriptFiles.length,
      sourceBytes: DaemonWorkspaceProfiler.distribution(sourceBytes),
      sourceLines: DaemonWorkspaceProfiler.distribution(sourceLines),
      symbolsPerFile: DaemonWorkspaceProfiler.distribution(symbolsPerFile),
      packageCount: files.filter((file) => /(?:^|\/)package\.json$/.test(file.relative)).length,
      configCount: configFiles.length,
      projectReferenceCount,
      importsPerFile: DaemonWorkspaceProfiler.distribution(importsPerFile),
      referenceFanout: DaemonWorkspaceProfiler.distribution(referenceFanout),
      aliasImportRatio: importCount === 0 ? 0 : aliasImportCount / importCount,
      workspaceImportRatio: importCount === 0 ? 0 : workspaceImportCount / importCount,
      callInDegree: DaemonWorkspaceProfiler.distribution(callOutDegree),
      callOutDegree: DaemonWorkspaceProfiler.distribution(callOutDegree),
      callDepth: DaemonWorkspaceProfiler.distribution(callDepth),
      cycleRatio: 0,
      declarationKindCounts:
        Object.keys(declarationKindCounts).length === 0 ? { none: 0 } : declarationKindCounts,
      representativeResultCounts: {
        overview: 0,
        resolve: 0,
        def: 0,
        refs: 0,
        context: 0,
        graph: 0,
        stats: 0,
        help: 0,
        version: 0,
        unknown: 0,
      },
      ignoredPathRatio: 0,
      nestedWorkspaceRatio: 0,
    });
  }

  private static distribution(values: readonly number[]): DistributionSummary {
    if (values.length === 0) return { minimum: 0, p50: 0, p95: 0, maximum: 0 };
    const sorted = [...values].sort((left, right) => left - right);
    return {
      minimum: sorted[0]!,
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      maximum: sorted.at(-1)!,
    };
  }

  private static maximumBraceDepth(source: string): number {
    let depth = 0;
    let maximum = 0;
    for (const character of source) {
      if (character === "{") maximum = Math.max(maximum, ++depth);
      if (character === "}") depth = Math.max(0, depth - 1);
    }
    return maximum;
  }
}
