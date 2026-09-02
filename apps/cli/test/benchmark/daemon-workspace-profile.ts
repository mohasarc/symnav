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
  readonly aliasImportRatio: number;
  readonly workspaceImportRatio: number;
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
    "aliasImportRatio",
    "workspaceImportRatio",
  ] as const;

  private static readonly distributionFields = ["minimum", "p50", "p95", "maximum"] as const;

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
    ] as const) {
      this.assertDistribution(value[field]);
    }
    for (const field of ["aliasImportRatio", "workspaceImportRatio"] as const) {
      this.assertRatio(value[field], field);
    }
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
      sourceBytes.push(Buffer.byteLength(source));
      sourceLines.push(
        source.length === 0 ? 0 : source.split("\n").length - Number(source.endsWith("\n")),
      );
      symbolsPerFile.push(declarations.length);
      importsPerFile.push(imports.length);
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
      aliasImportRatio: importCount === 0 ? 0 : aliasImportCount / importCount,
      workspaceImportRatio: importCount === 0 ? 0 : workspaceImportCount / importCount,
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
}
