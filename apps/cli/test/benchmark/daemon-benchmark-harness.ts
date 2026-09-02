import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  TypeScriptBackend,
  TypeScriptFileEntryExtractor,
  type TypeScriptFileExtractionRequest,
  type TypeScriptFileExtractor,
  type TypeScriptSemanticQueryObserver,
} from "@symnav/backend-typescript";
import { formatSymbolIdentity, NodeFileSystem } from "@symnav/core";
import type {
  BackendRefreshRequest,
  BackendRefreshSummary,
  FileMetadata,
  FileSystem,
} from "@symnav/core";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
} from "../../src/command-execution-result.js";
import { RetainedWorkspaceProgram } from "../../src/daemon/retained-workspace-program.js";
import { fakeDependencies } from "../integration/commands/helpers/fake-program-dependencies.js";

export interface DaemonBenchmarkMeasurement {
  readonly fileCount: number;
  readonly counts: {
    readonly projectLoads: number;
    readonly snapshots: number;
    readonly refreshes: number;
    readonly definitionLookups: number;
    readonly referenceSearches: number;
    readonly callTargetResolutions: number;
    readonly duplicateReferenceSearches: number;
    readonly duplicateCallTargetResolutions: number;
    readonly semanticProjectLoads: number;
    readonly semanticProjectFiles: number;
    readonly sourceReads: number;
    readonly extractions: number;
  };
  readonly refreshes: readonly BackendRefreshSummary[];
  readonly firstResolveMs: number;
  readonly secondResolveMs: number;
  readonly target: DaemonBenchmarkTargetComparison;
}

interface BenchmarkCounters {
  projectLoads: number;
  definitionLookups: number;
  referenceSearches: number;
  callTargetResolutions: number;
  duplicateReferenceSearches: number;
  duplicateCallTargetResolutions: number;
  semanticProjectLoads: number;
  semanticProjectFiles: number;
  extractions: number;
  readonly referenceSearchesThisTurn: Set<string>;
  readonly callTargetResolutionsThisTurn: Set<string>;
  readonly refreshes: BackendRefreshSummary[];
}

export interface DaemonBenchmarkTargetComparison {
  readonly secondResolveMs: number;
  readonly minimumFirstToSecondRatio: number;
  readonly secondResolveMet: boolean;
  readonly firstToSecondRatioMet: boolean;
  readonly wallClockGated: false;
}

export class DaemonBenchmarkTarget {
  constructor(
    private readonly secondResolveThresholdMs = 200,
    private readonly minimumFirstToSecondRatio = 2,
  ) {}

  compare(firstResolveMs: number, secondResolveMs: number): DaemonBenchmarkTargetComparison {
    const ratio =
      secondResolveMs === 0 ? Number.POSITIVE_INFINITY : firstResolveMs / secondResolveMs;
    return {
      secondResolveMs: this.secondResolveThresholdMs,
      minimumFirstToSecondRatio: this.minimumFirstToSecondRatio,
      secondResolveMet: secondResolveMs < this.secondResolveThresholdMs,
      firstToSecondRatioMet: ratio >= this.minimumFirstToSecondRatio,
      wallClockGated: false,
    };
  }
}

export class DaemonBenchmarkHarness {
  constructor(private readonly fileCount: number) {}

  async run(): Promise<DaemonBenchmarkMeasurement> {
    const workspaceRoot = this.createWorkspace();
    try {
      return await this.measure(workspaceRoot);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  private createWorkspace(): string {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-benchmark-"));
    const leftSourceDirectory = join(workspaceRoot, "packages", "left", "src");
    const rightSourceDirectory = join(workspaceRoot, "packages", "right", "src");
    mkdirSync(join(workspaceRoot, ".git"));
    mkdirSync(leftSourceDirectory, { recursive: true });
    mkdirSync(rightSourceDirectory, { recursive: true });
    writeFileSync(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "packages/left" }, { path: "packages/right" }],
      }),
    );
    for (const packageName of ["left", "right"]) {
      writeFileSync(
        join(workspaceRoot, "packages", packageName, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { composite: true }, include: ["src/**/*.ts"] }),
      );
    }
    for (let index = 0; index < this.fileCount; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const sourceDirectory =
        index < Math.ceil(this.fileCount / 2) ? leftSourceDirectory : rightSourceDirectory;
      writeFileSync(join(sourceDirectory, `module-${suffix}.ts`), this.moduleSource(index, suffix));
    }
    return workspaceRoot;
  }

  private moduleSource(index: number, suffix: string): string {
    if (index === 0) {
      const targetSuffix = String(this.fileCount - 1).padStart(4, "0");
      return [
        `import { symbol${targetSuffix} } from "../../right/src/module-${targetSuffix}.js";`,
        `export function benchmarkEntry(): number { return symbol${targetSuffix}(); }`,
        "",
      ].join("\n");
    }
    if (index === this.fileCount - 1) {
      return [
        "export function benchmarkLeaf(): number { return 1; }",
        "export function benchmarkLeft(): number { return benchmarkLeaf(); }",
        "export function benchmarkRight(): number { return benchmarkLeaf(); }",
        `export function symbol${suffix}(): number { return benchmarkLeft() + benchmarkRight(); }`,
        "",
      ].join("\n");
    }
    return `export const symbol${suffix}: number = ${index};\n`;
  }

  private async measure(workspaceRoot: string): Promise<DaemonBenchmarkMeasurement> {
    const fileSystem = new SnapshotCountingFileSystem(new NodeFileSystem());
    const counters: BenchmarkCounters = {
      projectLoads: 0,
      definitionLookups: 0,
      referenceSearches: 0,
      callTargetResolutions: 0,
      duplicateReferenceSearches: 0,
      duplicateCallTargetResolutions: 0,
      semanticProjectLoads: 0,
      semanticProjectFiles: 0,
      extractions: 0,
      referenceSearchesThisTurn: new Set(),
      callTargetResolutionsThisTurn: new Set(),
      refreshes: [],
    };
    const retainedProgram = new RetainedWorkspaceProgram(
      fakeDependencies({
        fs: fileSystem,
        backends: () => {
          counters.projectLoads += 1;
          return [new InstrumentedTypeScriptBackend(fileSystem, counters)];
        },
      }),
    );
    const request = {
      argv: ["resolve", `symbol${String(this.fileCount - 1).padStart(4, "0")}`],
      cwd: workspaceRoot,
      telemetryEnabled: false,
      executionMode: "warm",
    } as const;
    const first = await this.timeExecution(() => retainedProgram.execute(request));
    const second = await this.timeExecution(() => retainedProgram.execute(request));
    const targetSuffix = String(this.fileCount - 1).padStart(4, "0");
    const definitionRequest: CliExecutionRequest = {
      ...request,
      argv: ["def", `packages/right/src/module-${targetSuffix}.ts::symbol${targetSuffix}`],
    };
    await this.executeStablePair(retainedProgram, definitionRequest, "definition");
    const semanticRequests: readonly [string, readonly string[]][] = [
      ["references", ["refs", definitionRequest.argv[1]!, "--all"]],
      ["context", ["context", definitionRequest.argv[1]!]],
      ["graph", ["graph", definitionRequest.argv[1]!, "--outgoing", "--depth", "2", "--all"]],
    ];
    for (const [label, argv] of semanticRequests) {
      await this.executeStablePair(retainedProgram, { ...request, argv }, label);
    }
    if (first.result.exitCode !== 0 || second.result.exitCode !== 0) {
      throw new Error(
        `Benchmark commands exited ${first.result.exitCode} and ${second.result.exitCode}`,
      );
    }
    if (JSON.stringify(first.result.frames) !== JSON.stringify(second.result.frames)) {
      throw new Error("First and second benchmark commands produced different output");
    }
    return {
      fileCount: this.fileCount,
      counts: {
        projectLoads: counters.projectLoads,
        snapshots: fileSystem.completeSnapshots(this.fileCount + 3),
        refreshes: counters.refreshes.length,
        definitionLookups: counters.definitionLookups,
        referenceSearches: counters.referenceSearches,
        callTargetResolutions: counters.callTargetResolutions,
        duplicateReferenceSearches: counters.duplicateReferenceSearches,
        duplicateCallTargetResolutions: counters.duplicateCallTargetResolutions,
        semanticProjectLoads: counters.semanticProjectLoads,
        semanticProjectFiles: counters.semanticProjectFiles,
        sourceReads: fileSystem.sourceReadCount(),
        extractions: counters.extractions,
      },
      refreshes: counters.refreshes,
      firstResolveMs: first.durationMs,
      secondResolveMs: second.durationMs,
      target: new DaemonBenchmarkTarget().compare(first.durationMs, second.durationMs),
    };
  }

  private async executeStablePair(
    retainedProgram: RetainedWorkspaceProgram,
    request: CliExecutionRequest,
    label: string,
  ): Promise<void> {
    const first = await retainedProgram.execute(request);
    const second = await retainedProgram.execute(request);
    if (first.exitCode !== 0 || second.exitCode !== 0) {
      throw new Error(
        `Benchmark ${label} commands exited ${first.exitCode} and ${second.exitCode}`,
      );
    }
    if (JSON.stringify(first.frames) !== JSON.stringify(second.frames)) {
      throw new Error(`First and second benchmark ${label} commands produced different output`);
    }
  }

  private async timeExecution(
    execute: () => Promise<CommandExecutionResult>,
  ): Promise<{ readonly durationMs: number; readonly result: CommandExecutionResult }> {
    const startedAt = performance.now();
    const result = await execute();
    return { durationMs: performance.now() - startedAt, result };
  }
}

class InstrumentedTypeScriptBackend extends TypeScriptBackend {
  constructor(
    fileSystem: FileSystem,
    private readonly counters: BenchmarkCounters,
  ) {
    const observer: TypeScriptSemanticQueryObserver = {
      semanticProjectLoaded: (fileCount) => {
        counters.semanticProjectLoads += 1;
        counters.semanticProjectFiles += fileCount;
      },
      definitionSearch: () => {
        counters.definitionLookups += 1;
      },
      referenceSearch: (identity) => {
        counters.referenceSearches += 1;
        const key = formatSymbolIdentity(identity);
        if (counters.referenceSearchesThisTurn.has(key)) {
          counters.duplicateReferenceSearches += 1;
        }
        counters.referenceSearchesThisTurn.add(key);
      },
      callTargetResolution: (relativePath, start) => {
        counters.callTargetResolutions += 1;
        const key = `${relativePath}:${start}`;
        if (counters.callTargetResolutionsThisTurn.has(key)) {
          counters.duplicateCallTargetResolutions += 1;
        }
        counters.callTargetResolutionsThisTurn.add(key);
      },
    };
    super(
      fileSystem,
      undefined,
      undefined,
      observer,
      new CountingTypeScriptFileExtractor(() => {
        counters.extractions += 1;
      }),
    );
  }

  override async refresh(request: BackendRefreshRequest): Promise<BackendRefreshSummary> {
    this.counters.referenceSearchesThisTurn.clear();
    this.counters.callTargetResolutionsThisTurn.clear();
    const summary = await super.refresh(request);
    this.counters.refreshes.push(summary);
    return summary;
  }
}

class CountingTypeScriptFileExtractor implements TypeScriptFileExtractor {
  private readonly extractor = new TypeScriptFileEntryExtractor();

  constructor(private readonly extracted: () => void) {}

  extract(request: TypeScriptFileExtractionRequest) {
    this.extracted();
    return this.extractor.extract(request);
  }
}

class SnapshotCountingFileSystem implements FileSystem {
  private metadataReads = 0;
  private sourceReads = 0;

  constructor(private readonly fileSystem: FileSystem) {}

  completeSnapshots(fileCount: number): number {
    if (this.metadataReads % fileCount !== 0) {
      throw new Error(`${this.metadataReads} metadata reads do not form complete snapshots`);
    }
    return this.metadataReads / fileCount;
  }

  sourceReadCount(): number {
    return this.sourceReads;
  }

  readFile(absPath: string): Promise<string> {
    return this.fileSystem.readFile(absPath);
  }

  exists(absPath: string): Promise<boolean> {
    return this.fileSystem.exists(absPath);
  }

  listDir(absPath: string): Promise<readonly string[]> {
    return this.fileSystem.listDir(absPath);
  }

  isDirectory(absPath: string): Promise<boolean> {
    return this.fileSystem.isDirectory(absPath);
  }

  metadata(absPath: string): Promise<FileMetadata> {
    if (!this.fileSystem.isDirectorySync(absPath)) this.metadataReads += 1;
    return this.fileSystem.metadata(absPath);
  }

  existsSync(absPath: string): boolean {
    return this.fileSystem.existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    if (TypeScriptBackend.accepts(absPath)) this.sourceReads += 1;
    return this.fileSystem.readFileSync(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    return this.fileSystem.listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.fileSystem.isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    return this.fileSystem.metadataSync(absPath);
  }
}
