import type { DaemonWorkspaceProfile } from "./daemon-workspace-profile.js";
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
    const packageCount = Math.max(
      2,
      Math.min(visibleTypeScriptFiles, this.options.profile.packageCount * this.options.scale),
    );
    this.initializeRepository(workspaceRoot);
    this.writeRootConfiguration(workspaceRoot, packageCount);
    const firstModuleByPackage = this.writePackages(
      workspaceRoot,
      packageCount,
      visibleTypeScriptFiles,
    );
    this.writePackageManifests(workspaceRoot, firstModuleByPackage);
    this.writeBoundaries(workspaceRoot);
    this.commit(workspaceRoot, "generated-foundation", "2000-01-01T00:00:00Z");
    this.write(
      join(workspaceRoot, "GENERATOR"),
      `${this.options.generatorVersion}\n${this.seedMarker}\n`,
    );
    this.commit(workspaceRoot, "generated-profile", "2000-01-02T00:00:00Z");

    const targetFile = "packages/package-000/src/module-000000.ts";
    const target = `${targetFile}::benchmarkHub`;
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
        remove: "packages/package-000/src/module-000000.ts",
        renameFrom: "packages/package-001/src/module-000001.ts",
        renameTo: "packages/package-001/src/renamed.ts",
        ignoreRule: ".gitignore",
        nestedWorkspaceFile: "nested/nested.ts",
      },
      expectedProfile: this.scaledProfile(packageCount, visibleTypeScriptFiles),
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

  private writeRootConfiguration(workspaceRoot: string, packageCount: number): void {
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
          references: packageNames.map((name) => ({ path: `./packages/${name}` })),
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
        this.moduleSource(index),
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

  private moduleSource(index: number): string {
    if (index === 0) {
      return [
        `export const generatorSeed = "${this.seedMarker}";`,
        "export function benchmarkHub(value: number): number { return value + 1; }",
        "export function cycleEntry(value: number): number { return value <= 0 ? 0 : cycleExit(value - 1); }",
        "export function cycleExit(value: number): number { return cycleEntry(value); }",
        "",
      ].join("\n");
    }
    const suffix = String(index).padStart(6, "0");
    return [
      'import { benchmarkHub } from "@workspace/package-000";',
      `export function symbol${suffix}(value: number): number {`,
      `  return benchmarkHub(value) + ${index % 17};`,
      "}",
      "",
    ].join("\n");
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
      configCount: packageCount + 1,
      projectReferenceCount: packageCount,
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
