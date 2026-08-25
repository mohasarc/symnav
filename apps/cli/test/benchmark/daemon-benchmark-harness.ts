import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  TypeScriptBackend,
  TypeScriptFileEntryExtractor,
  TypeScriptWorkspaceState,
  type TypeScriptFileExtractionRequest,
  type TypeScriptFileExtractor,
} from "@symnav/backend-typescript";
import { NodeFileSystem } from "@symnav/core";
import type {
  BackendRefreshRequest,
  BackendRefreshSummary,
  FileMetadata,
  FileSystem,
  ResolvedPath,
  SymbolIdentity,
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
  extractions: number;
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
    const sourceDirectory = join(workspaceRoot, "src");
    mkdirSync(join(workspaceRoot, ".git"));
    mkdirSync(sourceDirectory);
    for (let index = 0; index < this.fileCount; index += 1) {
      const suffix = String(index).padStart(4, "0");
      writeFileSync(
        join(sourceDirectory, `module-${suffix}.ts`),
        `export const symbol${suffix}: number = ${index};\n`,
      );
    }
    return workspaceRoot;
  }

  private async measure(workspaceRoot: string): Promise<DaemonBenchmarkMeasurement> {
    const fileSystem = new SnapshotCountingFileSystem(new NodeFileSystem());
    const counters: BenchmarkCounters = {
      projectLoads: 0,
      definitionLookups: 0,
      extractions: 0,
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
      argv: ["def", `src/module-${targetSuffix}.ts::symbol${targetSuffix}`],
    };
    const firstDefinition = await retainedProgram.execute(definitionRequest);
    const secondDefinition = await retainedProgram.execute(definitionRequest);
    if (first.result.exitCode !== 0 || second.result.exitCode !== 0) {
      throw new Error(
        `Benchmark commands exited ${first.result.exitCode} and ${second.result.exitCode}`,
      );
    }
    if (JSON.stringify(first.result.frames) !== JSON.stringify(second.result.frames)) {
      throw new Error("First and second benchmark commands produced different output");
    }
    if (firstDefinition.exitCode !== 0 || secondDefinition.exitCode !== 0) {
      throw new Error(
        `Benchmark definition commands exited ${firstDefinition.exitCode} and ${secondDefinition.exitCode}`,
      );
    }
    if (JSON.stringify(firstDefinition.frames) !== JSON.stringify(secondDefinition.frames)) {
      throw new Error("First and second benchmark definition commands produced different output");
    }
    return {
      fileCount: this.fileCount,
      counts: {
        projectLoads: counters.projectLoads,
        snapshots: fileSystem.completeSnapshots(this.fileCount),
        refreshes: counters.refreshes.length,
        definitionLookups: counters.definitionLookups,
        sourceReads: fileSystem.sourceReadCount(),
        extractions: counters.extractions,
      },
      refreshes: counters.refreshes,
      firstResolveMs: first.durationMs,
      secondResolveMs: second.durationMs,
      target: new DaemonBenchmarkTarget().compare(first.durationMs, second.durationMs),
    };
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
    super(
      fileSystem,
      new TypeScriptWorkspaceState(
        fileSystem,
        new CountingTypeScriptFileExtractor(() => {
          counters.extractions += 1;
        }),
      ),
    );
  }

  override async refresh(request: BackendRefreshRequest): Promise<BackendRefreshSummary> {
    const summary = await super.refresh(request);
    this.counters.refreshes.push(summary);
    return summary;
  }

  override async findDefinitions(files: readonly ResolvedPath[], identity: SymbolIdentity) {
    this.counters.definitionLookups += 1;
    return super.findDefinitions(files, identity);
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
