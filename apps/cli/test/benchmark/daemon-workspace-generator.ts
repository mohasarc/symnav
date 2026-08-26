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
}

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

export class DaemonWorkspaceGenerator {
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
    const removableIndex = visibleTypeScriptFiles - 1;
    const removablePackage = removableIndex % packageDirectoryCount;
    const removableFile = `packages/package-${String(removablePackage).padStart(3, "0")}/src/module-${String(removableIndex).padStart(6, "0")}.ts`;
    return {
      workspaceRoot,
      commands: {
        overview: { argv: ["overview", targetFile], expectNonEmpty: true },
        resolve: { argv: ["resolve", "benchmarkHub"], expectNonEmpty: true },
        def: { argv: ["def", target], expectNonEmpty: true },
        refs: { argv: ["refs", target, "--all"], expectNonEmpty: true },
        context: { argv: ["context", target], expectNonEmpty: true },
        graph: { argv: ["graph", target, "--depth", "1"], expectNonEmpty: true },
        stats: { argv: ["stats", "--json"], expectNonEmpty: true },
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
            module: "NodeNext",
            moduleResolution: "NodeNext",
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
            compilerOptions: {
              composite: true,
              module: "NodeNext",
              moduleResolution: "NodeNext",
              target: "ES2022",
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
    const callCount = this.distributionValue(this.options.profile.callOutDegree, index, fileCount);
    if (index === 0) {
      const specialLines = [
        ...Array.from(
          { length: importCount },
          (_, importIndex) =>
            `import { symbol000001 as benchmarkImport${importIndex} } from "@workspace/package-001";`,
        ),
        `export const generatorSeed = "${this.seedMarker}";`,
        "export function benchmarkHub(value: number): number { return value + 1; }",
        "export function cycleEntry(value: number): number { return value <= 0 ? 0 : cycleExit(value - 1); }",
        "export function cycleExit(value: number): number { return cycleEntry(value); }",
      ];
      for (let symbolIndex = 4; symbolIndex < symbolCount; symbolIndex += 1) {
        specialLines.push(`export const benchmarkValue${symbolIndex} = ${symbolIndex};`);
      }
      return this.fitSource(specialLines, sourceLines, sourceBytes);
    }
    const suffix = String(index).padStart(6, "0");
    const directBenchmarkHubFiles =
      this.options.profile.representativeResultCounts.refs * this.options.scale;
    const lines = Array.from({ length: importCount }, (_, importIndex) => {
      const directBenchmarkHub = index <= directBenchmarkHubFiles && importIndex === 0;
      const targetPackage = directBenchmarkHub
        ? 0
        : 1 + ((index + importIndex) % (packageCount - 1));
      const importedSymbol =
        targetPackage === 0 ? "benchmarkHub" : `symbol${String(targetPackage).padStart(6, "0")}`;
      return `import { ${importedSymbol} as benchmarkImport${importIndex} } from "@workspace/package-${String(targetPackage).padStart(3, "0")}";`;
    });
    if (symbolCount > 0) {
      lines.push(`export function symbol${suffix}(value: number): number {`);
      const executableCalls = Math.max(0, callCount - 2);
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
    if (distributionIndex < Math.ceil(fileCount * 0.5)) return distribution.p50;
    return distribution.p95;
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
      declarationKindCounts: Object.fromEntries(
        Object.entries(this.options.profile.declarationKindCounts).map(([kind, count]) => [
          kind,
          count * this.options.scale,
        ]),
      ),
      representativeResultCounts: Object.fromEntries(
        Object.entries(this.options.profile.representativeResultCounts).map(([command, count]) => [
          command,
          count * this.options.scale,
        ]),
      ) as DaemonWorkspaceProfile["representativeResultCounts"],
    };
  }

  private write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
}
