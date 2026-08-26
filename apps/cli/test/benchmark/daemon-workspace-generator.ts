import type { DaemonWorkspaceProfile, DistributionSummary } from "./daemon-workspace-profile.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type DaemonBenchmarkScale = 1 | 2 | 3 | 10;

export interface DaemonWorkspaceGeneratorOptions {
  readonly profile: DaemonWorkspaceProfile;
  readonly generatorVersion: string;
  readonly seed: string;
  readonly scale: DaemonBenchmarkScale;
}

export interface DaemonBenchmarkCommand {
  readonly argv: readonly string[];
  readonly expectNonEmpty: boolean;
  readonly expectation?: DaemonBenchmarkResultExpectation;
}

export type DaemonBenchmarkResultExpectation =
  | { readonly kind: "overview"; readonly symbols: number }
  | { readonly kind: "resolve"; readonly symbols: number }
  | { readonly kind: "definition"; readonly symbols: number }
  | { readonly kind: "references"; readonly total: number }
  | { readonly kind: "context"; readonly callers: number; readonly callees: number }
  | { readonly kind: "graph"; readonly incomingPaths: number; readonly outgoingPaths: number }
  | { readonly kind: "stats-shape" };

export interface DaemonBenchmarkCommandSuite {
  readonly overview: DaemonBenchmarkCommand;
  readonly resolve: DaemonBenchmarkCommand;
  readonly def: DaemonBenchmarkCommand;
  readonly refs: DaemonBenchmarkCommand;
  readonly context: DaemonBenchmarkCommand;
  readonly graph: DaemonBenchmarkCommand;
  readonly stats: DaemonBenchmarkCommand;
}

export interface DaemonBenchmarkMutationSuite {
  readonly sameSizeEdit: string;
  readonly add: string;
  readonly remove: string;
  readonly removeSymbol: string;
  readonly renameFrom: string;
  readonly renameTo: string;
  readonly ignoreRule: string;
  readonly nestedWorkspaceFile: string;
}

export interface GeneratedDaemonWorkspace {
  readonly workspaceRoot: string;
  readonly commands: DaemonBenchmarkCommandSuite;
  readonly mutations: DaemonBenchmarkMutationSuite;
  readonly expectedProfile: DaemonWorkspaceProfile;
}

type GeneratedImportKind = "relative" | "path-alias" | "workspace";

export class DaemonWorkspaceGenerator {
  private generatedImportKinds: readonly GeneratedImportKind[] = [];
  private generatedImportIndex = 0;

  constructor(private readonly options: DaemonWorkspaceGeneratorOptions) {}

  async generate(destination: string): Promise<GeneratedDaemonWorkspace> {
    const workspaceRoot = resolve(destination);
    const visibleTypeScriptFiles = this.options.profile.visibleTypeScriptFiles * this.options.scale;
    const totalPackageCount = Math.max(
      3,
      Math.min(visibleTypeScriptFiles + 1, this.options.profile.packageCount * this.options.scale),
    );
    const packageDirectoryCount = totalPackageCount - 1;
    const configCount = this.options.profile.configCount * this.options.scale;
    const projectReferenceCount = this.options.profile.projectReferenceCount * this.options.scale;
    this.generatedImportKinds = this.buildImportKinds(visibleTypeScriptFiles);
    this.generatedImportIndex = 0;
    this.initializeRepository(workspaceRoot);
    this.writeRootConfiguration(
      workspaceRoot,
      packageDirectoryCount,
      Math.min(packageDirectoryCount, projectReferenceCount),
    );
    const firstModuleByPackage = this.writePackages(
      workspaceRoot,
      packageDirectoryCount,
      visibleTypeScriptFiles,
    );
    this.writePackageManifests(workspaceRoot, firstModuleByPackage);
    this.writeAdditionalConfigurations(
      workspaceRoot,
      packageDirectoryCount,
      configCount - packageDirectoryCount - 1,
      Math.max(0, projectReferenceCount - packageDirectoryCount),
    );
    this.writeBoundaries(workspaceRoot);
    this.commit(workspaceRoot, "generated-foundation", "2000-01-01T00:00:00Z");
    this.write(
      join(workspaceRoot, "GENERATOR"),
      `${this.options.generatorVersion}\n${this.seedMarker}\n`,
    );
    this.commit(workspaceRoot, "generated-profile", "2000-01-02T00:00:00Z");

    const targetFile = "packages/package-000/src/module-000000.ts";
    const target = `${targetFile}::benchmarkHub`;
    const representativeFileCount = Array.from(
      { length: Math.min(28, visibleTypeScriptFiles - 1) },
      (_, index) => index + 1,
    ).filter(
      (index) =>
        this.distributionValue(this.options.profile.symbolsPerFile, index, visibleTypeScriptFiles) >
          0 &&
        this.distributionValue(this.options.profile.importsPerFile, index, visibleTypeScriptFiles) >
          0,
    ).length;
    const representativeOverviewSymbols = Math.max(
      4,
      this.distributionValue(this.options.profile.symbolsPerFile, 0, visibleTypeScriptFiles),
    );
    const removableIndex = visibleTypeScriptFiles - 1;
    const removablePackage = removableIndex % packageDirectoryCount;
    const removableFile = `packages/package-${String(removablePackage).padStart(3, "0")}/src/module-${String(removableIndex).padStart(6, "0")}.ts`;
    return {
      workspaceRoot,
      commands: {
        overview: {
          argv: ["overview", targetFile, "--json"],
          expectNonEmpty: true,
          expectation: { kind: "overview", symbols: representativeOverviewSymbols },
        },
        resolve: {
          argv: ["resolve", "benchmarkHub", "--json"],
          expectNonEmpty: true,
          expectation: { kind: "resolve", symbols: 1 },
        },
        def: {
          argv: ["def", target, "--json"],
          expectNonEmpty: true,
          expectation: { kind: "definition", symbols: 1 },
        },
        refs: {
          argv: ["refs", target, "--all", "--json"],
          expectNonEmpty: true,
          expectation: { kind: "references", total: representativeFileCount * 3 },
        },
        context: {
          argv: ["context", target, "--json"],
          expectNonEmpty: true,
          expectation: { kind: "context", callers: representativeFileCount, callees: 1 },
        },
        graph: {
          argv: ["graph", target, "--depth", "1", "--json"],
          expectNonEmpty: true,
          expectation: {
            kind: "graph",
            incomingPaths: representativeFileCount,
            outgoingPaths: 1,
          },
        },
        stats: {
          argv: ["stats", "--json"],
          expectNonEmpty: true,
          expectation: { kind: "stats-shape" },
        },
      },
      mutations: {
        sameSizeEdit: targetFile,
        add: "packages/package-000/src/added.ts",
        remove: removableFile,
        removeSymbol: `symbol${String(removableIndex).padStart(6, "0")}`,
        renameFrom: "packages/package-001/src/module-000001.ts",
        renameTo: "packages/package-001/src/renamed.ts",
        ignoreRule: ".gitignore",
        nestedWorkspaceFile: "nested/nested.ts",
      },
      expectedProfile: this.scaledProfile(totalPackageCount, visibleTypeScriptFiles),
    };
  }

  private get seedMarker(): string {
    return createHash("sha256")
      .update(this.options.generatorVersion)
      .update("\0")
      .update(this.options.seed)
      .digest("hex")
      .slice(0, 16);
  }

  private initializeRepository(workspaceRoot: string): void {
    mkdirSync(workspaceRoot, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main", workspaceRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceRoot, "config", "core.autocrlf", "false"]);
    execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "Symnav Benchmark"]);
    execFileSync("git", ["-C", workspaceRoot, "config", "user.email", "benchmark@example.invalid"]);
  }

  private writeRootConfiguration(
    workspaceRoot: string,
    packageCount: number,
    projectReferenceCount: number,
  ): void {
    const packageNames = Array.from(
      { length: packageCount },
      (_, index) => `package-${String(index).padStart(3, "0")}`,
    );
    this.write(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }, undefined, 2) + "\n",
    );
    this.write(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify(
        {
          files: [],
          compilerOptions: {
            composite: true,
            baseUrl: ".",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            paths: Object.fromEntries(
              packageNames.map((name, index) => [
                `@alias/${name}`,
                [`packages/${name}/src/module-${String(index).padStart(6, "0")}.ts`],
              ]),
            ),
            target: "ES2022",
          },
          references: packageNames
            .slice(0, projectReferenceCount)
            .map((name) => ({ path: `./packages/${name}` })),
        },
        undefined,
        2,
      ) + "\n",
    );
  }

  private writePackages(
    workspaceRoot: string,
    packageCount: number,
    visibleTypeScriptFiles: number,
  ): ReadonlyMap<number, string> {
    const firstModuleByPackage = new Map<number, string>();
    for (let index = 0; index < visibleTypeScriptFiles; index += 1) {
      const packageIndex = index % packageCount;
      const suffix = String(index).padStart(6, "0");
      const moduleName = `module-${suffix}.ts`;
      firstModuleByPackage.set(packageIndex, firstModuleByPackage.get(packageIndex) ?? moduleName);
      this.write(
        join(
          workspaceRoot,
          "packages",
          `package-${String(packageIndex).padStart(3, "0")}`,
          "src",
          moduleName,
        ),
        this.moduleSource(index, visibleTypeScriptFiles, packageCount),
      );
    }
    return firstModuleByPackage;
  }

  private writePackageManifests(
    workspaceRoot: string,
    firstModuleByPackage: ReadonlyMap<number, string>,
  ): void {
    for (const [packageIndex, moduleName] of firstModuleByPackage) {
      const packageName = `package-${String(packageIndex).padStart(3, "0")}`;
      const packageRoot = join(workspaceRoot, "packages", packageName);
      this.write(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            name: `@workspace/${packageName}`,
            private: true,
            type: "module",
            exports: `./src/${moduleName}`,
          },
          undefined,
          2,
        ) + "\n",
      );
      this.write(
        join(packageRoot, "tsconfig.json"),
        JSON.stringify(
          {
            extends: "../../tsconfig.json",
            compilerOptions: {
              composite: true,
              rootDir: "src",
              outDir: "dist",
            },
            include: ["src/**/*.ts"],
          },
          undefined,
          2,
        ) + "\n",
      );
    }
  }

  private writeAdditionalConfigurations(
    workspaceRoot: string,
    packageCount: number,
    additionalConfigCount: number,
    additionalReferenceCount: number,
  ): void {
    if (additionalConfigCount < 0) throw new Error("Profile config count is undersized");
    let remainingReferences = additionalReferenceCount;
    for (let index = 0; index < additionalConfigCount; index += 1) {
      const remainingConfigs = additionalConfigCount - index;
      const referenceCount = Math.ceil(remainingReferences / remainingConfigs);
      const references = Array.from({ length: referenceCount }, (_, referenceIndex) => ({
        path: `../packages/package-${String(referenceIndex % packageCount).padStart(3, "0")}`,
      }));
      remainingReferences -= referenceCount;
      this.write(
        join(workspaceRoot, "configs", `tsconfig-extra-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({ files: [], references }, undefined, 2) + "\n",
      );
    }
    if (remainingReferences !== 0) throw new Error("Profile project references are undersized");
  }

  private moduleSource(index: number, fileCount: number, packageCount: number): string {
    const sourceBytes = this.distributionValue(this.options.profile.sourceBytes, index, fileCount);
    const sourceLines = this.distributionValue(this.options.profile.sourceLines, index, fileCount);
    const symbolCount = this.distributionValue(
      this.options.profile.symbolsPerFile,
      index,
      fileCount,
    );
    const importCount = this.distributionValue(
      this.options.profile.importsPerFile,
      index,
      fileCount,
    );
    const callCount = Math.min(importCount, 2 + (index % 12));
    if (index === 0) {
      const specialLines = [
        ...Array.from(
          { length: importCount },
          (_, importIndex) =>
            `import { symbol000001 as benchmarkImport${importIndex} } from "${this.importSpecifier(0, 1, this.nextImportKind())}";`,
        ),
        `export const generatorSeed = "${this.seedMarker}";`,
        "export function benchmarkHub(value: number): number { return benchmarkImport0(value) + 1; }",
        "export function cycleEntry(value: number): number { return value <= 0 ? 0 : cycleExit(value - 1); }",
        "export function cycleExit(value: number): number { return cycleEntry(value); }",
      ];
      for (let symbolIndex = 4; symbolIndex < symbolCount; symbolIndex += 1) {
        specialLines.push(`export const benchmarkValue${symbolIndex} = ${symbolIndex};`);
      }
      return this.fitSource(specialLines, sourceLines, sourceBytes);
    }
    const suffix = String(index).padStart(6, "0");
    const directBenchmarkHubFiles = Math.min(28, fileCount - 1);
    const lines = Array.from({ length: importCount }, (_, importIndex) => {
      const directBenchmarkHub = index <= directBenchmarkHubFiles && importIndex === 0;
      const targetPackage = directBenchmarkHub
        ? 0
        : 1 + ((index + importIndex) % (packageCount - 1));
      const importedSymbol =
        targetPackage === 0 ? "benchmarkHub" : `symbol${String(targetPackage).padStart(6, "0")}`;
      const currentPackage = index % packageCount;
      const importSpecifier = this.importSpecifier(
        currentPackage,
        targetPackage,
        this.nextImportKind(),
      );
      return `import { ${importedSymbol} as benchmarkImport${importIndex} } from "${importSpecifier}";`;
    });
    if (symbolCount > 0) {
      lines.push(`export function symbol${suffix}(value: number): number {`);
      const directBenchmarkHubFile = index <= directBenchmarkHubFiles;
      const executableCalls = directBenchmarkHubFile ? 0 : Math.max(0, callCount - 2);
      for (let callIndex = 0; callIndex < executableCalls && importCount > 0; callIndex += 1) {
        lines.push(`  benchmarkImport${callIndex % importCount}(value);`);
      }
      lines.push(
        importCount === 0
          ? `  return value + ${index % 17};`
          : `  return benchmarkImport0(value) + ${index % 17};`,
        "}",
      );
      for (let symbolIndex = 1; symbolIndex < symbolCount; symbolIndex += 1) {
        lines.push(`export const value${suffix}_${symbolIndex} = ${symbolIndex};`);
      }
    }
    if (lines.length === 0) lines.push("// generated");
    return this.fitSource(lines, sourceLines, sourceBytes);
  }

  private distributionValue(
    distribution: DistributionSummary,
    index: number,
    fileCount: number,
  ): number {
    const medianIndex = Math.ceil(fileCount * 0.5) - 1;
    const distributionIndex = index === 0 ? medianIndex : index === medianIndex ? 0 : index;
    if (distributionIndex === 0) return distribution.minimum;
    if (distributionIndex === fileCount - 1) return distribution.maximum;
    if (distributionIndex < Math.ceil(fileCount * 0.95) - 1) return distribution.p50;
    return distribution.p95;
  }

  private buildImportKinds(fileCount: number): readonly GeneratedImportKind[] {
    let totalImportCount = 0;
    for (let index = 0; index < fileCount; index += 1) {
      totalImportCount += this.distributionValue(
        this.options.profile.importsPerFile,
        index,
        fileCount,
      );
    }
    const workspaceCount = Math.round(totalImportCount * this.options.profile.workspaceImportRatio);
    const aliasCount = Math.round(totalImportCount * this.options.profile.aliasImportRatio);
    if (workspaceCount > aliasCount) {
      throw new Error("Workspace import ratio exceeds alias import ratio");
    }
    const generatedImportKinds: GeneratedImportKind[] = [
      ...Array.from({ length: workspaceCount }, () => "workspace" as const),
      ...Array.from({ length: aliasCount - workspaceCount }, () => "path-alias" as const),
      ...Array.from({ length: totalImportCount - aliasCount }, () => "relative" as const),
    ];
    let shuffleState = Number.parseInt(this.seedMarker.slice(0, 8), 16) || 1;
    for (let index = generatedImportKinds.length - 1; index > 0; index -= 1) {
      shuffleState = (Math.imul(shuffleState, 1_664_525) + 1_013_904_223) >>> 0;
      const swapIndex = shuffleState % (index + 1);
      [generatedImportKinds[index], generatedImportKinds[swapIndex]] = [
        generatedImportKinds[swapIndex]!,
        generatedImportKinds[index]!,
      ];
    }
    return generatedImportKinds;
  }

  private nextImportKind(): GeneratedImportKind {
    const generatedImportKind = this.generatedImportKinds[this.generatedImportIndex];
    if (generatedImportKind === undefined) throw new Error("Generated import profile is exhausted");
    this.generatedImportIndex += 1;
    return generatedImportKind;
  }

  private importSpecifier(
    currentPackage: number,
    targetPackage: number,
    generatedImportKind: GeneratedImportKind,
  ): string {
    const targetPackageName = `package-${String(targetPackage).padStart(3, "0")}`;
    if (generatedImportKind === "workspace") return `@workspace/${targetPackageName}`;
    if (generatedImportKind === "path-alias") return `@alias/${targetPackageName}`;
    const targetModule = `module-${String(targetPackage).padStart(6, "0")}.js`;
    if (currentPackage === targetPackage) return `./${targetModule}`;
    return `../../${targetPackageName}/src/${targetModule}`;
  }

  private fitSource(lines: string[], targetLines: number, targetBytes: number): string {
    while (lines.length < targetLines) lines.push("//");
    let source = `${lines.join("\n")}\n`;
    const missingBytes = targetBytes - Buffer.byteLength(source);
    if (missingBytes <= 0) return source;
    lines[0] = `${lines[0]}${" ".repeat(missingBytes)}`;
    source = `${lines.join("\n")}\n`;
    return source;
  }

  private writeBoundaries(workspaceRoot: string): void {
    this.write(join(workspaceRoot, ".gitignore"), "ignored/\n");
    this.write(join(workspaceRoot, "ignored", "ignored.ts"), "export const ignored = true;\n");
    mkdirSync(join(workspaceRoot, "nested", ".git"), { recursive: true });
    this.write(join(workspaceRoot, "nested", "nested.ts"), "export const nested = true;\n");
  }

  private commit(workspaceRoot: string, message: string, timestamp: string): void {
    execFileSync("git", ["-C", workspaceRoot, "add", "."]);
    execFileSync("git", ["-C", workspaceRoot, "commit", "-m", message], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      },
    });
  }

  private scaledProfile(
    packageCount: number,
    visibleTypeScriptFiles: number,
  ): DaemonWorkspaceProfile {
    return {
      ...this.options.profile,
      visibleTypeScriptFiles,
      packageCount,
      configCount: this.options.profile.configCount * this.options.scale,
      projectReferenceCount: this.options.profile.projectReferenceCount * this.options.scale,
    };
  }

  private write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
}
