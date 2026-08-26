import type { DaemonResourcePolicyRecord } from "../../src/daemon/daemon-resource-monitor.js";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalStateDir } from "@symnav/telemetry";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonResourcePolicy } from "../../src/daemon/daemon-resource-monitor.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";
import { canonicalWorkspaceRoot } from "../helpers/canonical-workspace-root.js";
import type {
  DaemonBenchmarkGateResult,
  DaemonBenchmarkSample,
  DaemonBenchmarkStatistics,
} from "./daemon-benchmark-gate.js";
import { DAEMON_BENCHMARK_WARM_REPETITIONS, DaemonBenchmarkGate } from "./daemon-benchmark-gate.js";
import {
  DaemonWorkspaceGenerator,
  type DaemonBenchmarkCommand,
  type GeneratedDaemonWorkspace,
} from "./daemon-workspace-generator.js";
import type { DaemonBenchmarkScale } from "./daemon-workspace-generator.js";
import { DaemonWorkspaceProfiler } from "./daemon-workspace-profile.js";
import type { DaemonWorkspaceProfile } from "./daemon-workspace-profile.js";

export interface DaemonBenchmarkHarnessOptions {
  readonly profile: DaemonWorkspaceProfile;
  readonly scale: DaemonBenchmarkScale;
  readonly generatorVersion: string;
  readonly seed: string;
  readonly workspaceRoot?: string;
  readonly stateDirectory?: string;
}

export interface DaemonBenchmarkArtifact {
  readonly schemaVersion: 1;
  readonly profileVersion: string;
  readonly generatorVersion: string;
  readonly seed: string;
  readonly scale: DaemonBenchmarkScale;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly cpuCount: number;
  readonly resourcePolicy: DaemonResourcePolicyRecord;
  readonly startupMs: number;
  readonly commandStatistics: Readonly<Record<string, DaemonBenchmarkStatistics>>;
  readonly processRssPeakBytes: number;
  readonly workerHeapPeakBytes?: number;
  readonly spoolPeakBytes: number;
  readonly responsePeakBytes: number;
  readonly parity: boolean;
  readonly freshness: boolean;
  readonly statusResponsive: boolean;
  readonly continuity: boolean;
  readonly exactlyOnceTelemetry: boolean;
  readonly resourcesWithinPolicy: boolean;
  readonly spoolsCleaned: boolean;
  readonly failures: DaemonBenchmarkGateResult["failures"];
  readonly samples: readonly DaemonBenchmarkSample[];
}

export class DaemonScaleBenchmarkHarness {
  constructor(private readonly options: DaemonBenchmarkHarnessOptions) {}

  async run(): Promise<DaemonBenchmarkArtifact> {
    const ownsWorkspace = this.options.workspaceRoot === undefined;
    const ownsState = this.options.stateDirectory === undefined;
    const workspaceRoot =
      this.options.workspaceRoot ?? mkdtempSync(join(tmpdir(), "symnav-daemon-scale-workspace-"));
    const stateDirectory =
      this.options.stateDirectory ?? mkdtempSync(join(tmpdir(), "symnav-daemon-scale-state-"));
    let daemonStarted = false;
    try {
      const generated = await new DaemonWorkspaceGenerator(this.options).generate(workspaceRoot);
      const generatedProfile = await new DaemonWorkspaceProfiler().profile(workspaceRoot);
      const identity = DaemonWorkspaceIdentity.from(
        canonicalWorkspaceRoot(realpathSync(workspaceRoot)),
        canonicalStateDir(stateDirectory),
      );
      const startupStartedAt = performance.now();
      const started = this.runCommand(workspaceRoot, stateDirectory, ["daemon", "start"], false);
      const startupMs = performance.now() - startupStartedAt;
      if (started.status !== 0)
        throw new Error(`Daemon benchmark startup failed: ${started.stderr}`);
      daemonStarted = true;
      const registry = new DaemonRegistry(identity.registryDirectory);
      const initialRecord = registry.read(identity);
      if (initialRecord === undefined)
        throw new Error("Daemon benchmark startup record is missing");

      const samples = this.runFixedSuite(generated, stateDirectory);
      const freshness = this.runMutations(generated, stateDirectory);
      const statusStartedAt = performance.now();
      const status = this.runCommand(
        workspaceRoot,
        stateDirectory,
        ["daemon", "status", "--json"],
        false,
      );
      const statusMaximumMs = performance.now() - statusStartedAt;
      if (status.status !== 0) throw new Error("Daemon benchmark status failed");
      const finalRecord = registry.read(identity);
      if (finalRecord === undefined) throw new Error("Daemon benchmark final record is missing");
      const stopped = this.runCommand(
        workspaceRoot,
        stateDirectory,
        ["daemon", "stop"],
        false,
      );
      daemonStarted = false;
      if (stopped.status !== 0) throw new Error("Daemon benchmark shutdown failed");

      const diagnostics = DaemonBenchmarkDiagnostics.read(identity.logPath);
      const enrichedSamples = diagnostics.enrich(samples);
      const telemetryCount = this.warmTelemetryCount(stateDirectory);
      const resourcePolicy = DaemonResourcePolicy.fromSystemMemory(
        totalmem(),
        process.constrainedMemory?.(),
      ).record;
      const expectedTelemetryCount =
        enrichedSamples.filter((sample) => sample.command !== "stats").length + 6;
      const gate = new DaemonBenchmarkGate().evaluate({
        scale: this.options.scale,
        samples: enrichedSamples,
        expectedCommands: Object.keys(generated.commands) as (keyof typeof generated.commands)[],
        stdoutParity: samples.every((sample) => sample.stdoutParity),
        stderrParity: samples.every((sample) => sample.stderrParity),
        exitParity: samples.every((sample) => sample.exitParity),
        aliasResultsNonEmpty: samples
          .filter((sample) =>
            ["resolve", "def", "refs", "context", "graph"].includes(sample.command),
          )
          .every((sample) => sample.nonEmpty),
        freshness,
        statusMaximumMs,
        initialPid: initialRecord.pid,
        finalPid: finalRecord.pid,
        initialInstanceId: initialRecord.instanceId,
        finalInstanceId: finalRecord.instanceId,
        fallbackCount: this.fallbackTelemetryCount(stateDirectory),
        restartCount: diagnostics.restartCount,
        capacityResultCount: diagnostics.capacityResultCount,
        rawRuntimeFailureCount: diagnostics.rawRuntimeFailureCount,
        processRssPeakBytes: diagnostics.processRssPeakBytes,
        hardProcessRssBytes: resourcePolicy.hardProcessRssBytes,
        expectedTelemetryCount,
        actualTelemetryCount: telemetryCount,
        artifactComplete: diagnostics.complete(enrichedSamples.length),
        spoolBytesAfterCleanup: DaemonScaleBenchmarkHarness.directoryBytes(identity.spoolDirectory),
        diagnosticPhasesComplete: diagnostics.phasesComplete,
        generatedVisibleFiles: generatedProfile.visibleTypeScriptFiles,
        expectedVisibleFiles: generated.expectedProfile.visibleTypeScriptFiles,
        mutationsCurrent: freshness,
      });
      return {
        schemaVersion: 1,
        profileVersion: this.options.profile.profileVersion,
        generatorVersion: this.options.generatorVersion,
        seed: this.options.seed,
        scale: this.options.scale,
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        cpuCount: cpus().length,
        resourcePolicy,
        startupMs,
        commandStatistics: gate.commandStatistics,
        processRssPeakBytes: diagnostics.processRssPeakBytes,
        ...(diagnostics.workerHeapPeakBytes === undefined
          ? {}
          : { workerHeapPeakBytes: diagnostics.workerHeapPeakBytes }),
        spoolPeakBytes: diagnostics.spoolPeakBytes,
        responsePeakBytes: Math.max(...enrichedSamples.map((sample) => sample.responseBytes)),
        parity: gate.parity,
        freshness: gate.freshness,
        statusResponsive: gate.statusResponsive,
        continuity: gate.continuity,
        exactlyOnceTelemetry: gate.exactlyOnceTelemetry,
        resourcesWithinPolicy: gate.resourcesWithinPolicy,
        spoolsCleaned: gate.spoolsCleaned,
        failures: gate.failures,
        samples: enrichedSamples,
      };
    } finally {
      if (daemonStarted) {
        this.runCommand(workspaceRoot, stateDirectory, ["daemon", "stop", "--force"], false);
      }
      if (ownsWorkspace) rmSync(workspaceRoot, { recursive: true, force: true });
      if (ownsState) rmSync(stateDirectory, { recursive: true, force: true });
    }
  }

  private runFixedSuite(
    generated: GeneratedDaemonWorkspace,
    stateDirectory: string,
  ): BenchmarkSampleEvidence[] {
    const samples: BenchmarkSampleEvidence[] = [];
    for (const [command, benchmark] of Object.entries(generated.commands)) {
      const cold = this.runCommand(generated.workspaceRoot, stateDirectory, benchmark.argv, false);
      for (let repetition = 0; repetition < DAEMON_BENCHMARK_WARM_REPETITIONS; repetition += 1) {
        const startedAt = performance.now();
        const warm = this.runCommand(generated.workspaceRoot, stateDirectory, benchmark.argv, true);
        const wallMs = performance.now() - startedAt;
        samples.push(
          BenchmarkSampleEvidence.from(
            command as keyof typeof generated.commands,
            repetition,
            cold,
            warm,
            wallMs,
            benchmark,
          ),
        );
      }
    }
    return samples;
  }

  private runMutations(generated: GeneratedDaemonWorkspace, stateDirectory: string): boolean {
    const root = generated.workspaceRoot;
    let current = true;
    const editedPath = join(root, generated.mutations.sameSizeEdit);
    const original = readFileSync(editedPath, "utf8");
    writeFileSync(editedPath, original.replace("generatorSeed", "generatorSeed"), "utf8");
    current = this.parity(root, stateDirectory, generated.commands.overview.argv) && current;

    const addedPath = join(root, generated.mutations.add);
    writeFileSync(addedPath, "export const AddedBenchmarkSymbol = 1;\n", "utf8");
    current = this.parity(root, stateDirectory, ["resolve", "AddedBenchmarkSymbol"]) && current;

    unlinkSync(join(root, generated.mutations.remove));
    current = this.parity(root, stateDirectory, ["resolve", "removedBenchmarkSymbol"]) && current;

    renameSync(
      join(root, generated.mutations.renameFrom),
      join(root, generated.mutations.renameTo),
    );
    current =
      this.parity(root, stateDirectory, ["overview", generated.mutations.renameTo]) && current;

    appendFileSync(join(root, generated.mutations.ignoreRule), `${generated.mutations.add}\n`);
    current = this.parity(root, stateDirectory, ["overview", generated.mutations.add]) && current;
    current =
      this.parity(root, stateDirectory, ["overview", generated.mutations.nestedWorkspaceFile]) &&
      current;
    return current;
  }

  private parity(root: string, stateDirectory: string, argv: readonly string[]): boolean {
    const cold = this.runCommand(root, stateDirectory, argv, false);
    const warm = this.runCommand(root, stateDirectory, argv, true);
    return (
      cold.status === warm.status && cold.stdout === warm.stdout && cold.stderr === warm.stderr
    );
  }

  private runCommand(
    workspaceRoot: string,
    stateDirectory: string,
    argv: readonly string[],
    telemetry: boolean,
  ): RunSymnavBinaryResult {
    return runSymnavBinary(argv, {
      cwd: workspaceRoot,
      env: {
        SYMNAV_STATE_DIR: stateDirectory,
        SYMNAV_DAEMON: argv[0] === "daemon" ? undefined : telemetry ? "1" : "0",
        SYMNAV_TELEMETRY: telemetry ? "1" : "0",
      },
    });
  }

  private warmTelemetryCount(stateDirectory: string): number {
    return this.telemetryEvents(stateDirectory).filter((event) => event.executionMode === "warm")
      .length;
  }

  private fallbackTelemetryCount(stateDirectory: string): number {
    return this.telemetryEvents(stateDirectory).filter(
      (event) => event.executionMode === "fallback",
    ).length;
  }

  private telemetryEvents(stateDirectory: string): readonly Record<string, unknown>[] {
    const path = join(stateDirectory, "usage.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  private static directoryBytes(path: string): number {
    if (!existsSync(path)) return 0;
    let bytes = 0;
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const metadata = statSync(child);
      bytes += metadata.isDirectory() ? this.directoryBytes(child) : metadata.size;
    }
    return bytes;
  }
}

interface BenchmarkSampleEvidence extends DaemonBenchmarkSample {
  readonly stdoutParity: boolean;
  readonly stderrParity: boolean;
  readonly exitParity: boolean;
  readonly nonEmpty: boolean;
}

class BenchmarkSampleEvidence {
  static from(
    command: keyof GeneratedDaemonWorkspace["commands"],
    repetition: number,
    cold: RunSymnavBinaryResult,
    warm: RunSymnavBinaryResult,
    wallMs: number,
    benchmark: DaemonBenchmarkCommand,
  ): BenchmarkSampleEvidence {
    return {
      command,
      repetition,
      serviceMsExcludingQueue: wallMs,
      queueWaitMs: 0,
      stdoutDigest: this.digest(warm.stdout),
      stderrDigest: this.digest(warm.stderr),
      exitCode: warm.status ?? 1,
      responseBytes: Buffer.byteLength(warm.stdout) + Buffer.byteLength(warm.stderr),
      processRssPeakBytes: 0,
      spoolPeakBytes: 0,
      stdoutParity: cold.stdout === warm.stdout,
      stderrParity: cold.stderr === warm.stderr,
      exitParity: cold.status === warm.status,
      nonEmpty:
        !benchmark.expectNonEmpty ||
        (warm.status === 0 &&
          warm.stdout.trim().length > 0 &&
          warm.stdout.includes("benchmarkHub")),
    };
  }

  private static digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

interface OperationMetrics {
  readonly command: string;
  readonly queueWaitMs: number;
  readonly serviceMs: number;
  readonly processRssPeakBytes: number;
  readonly workerHeapPeakBytes?: number;
  readonly spoolBytes: number;
}

class DaemonBenchmarkDiagnostics {
  private constructor(
    private readonly operationMetrics: readonly OperationMetrics[],
    readonly restartCount: number,
    readonly capacityResultCount: number,
    readonly rawRuntimeFailureCount: number,
    readonly processRssPeakBytes: number,
    readonly workerHeapPeakBytes: number | undefined,
    readonly spoolPeakBytes: number,
    readonly phasesComplete: boolean,
  ) {}

  static read(logPath: string): DaemonBenchmarkDiagnostics {
    const events = existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    const commands = new Map<string, string>();
    const queueWaits = new Map<string, number>();
    for (const event of events) {
      if (event.kind === "request-accepted")
        commands.set(String(event.requestId), String(event.command));
      if (event.kind === "turn-started")
        queueWaits.set(String(event.requestId), Number(event.queueWaitMs));
    }
    const operationMetrics = events
      .filter((event) => event.kind === "execution-terminal")
      .map((event) => ({
        command: commands.get(String(event.requestId)) ?? "unknown",
        queueWaitMs: queueWaits.get(String(event.requestId)) ?? 0,
        serviceMs: Number(event.serviceMs),
        processRssPeakBytes: Number(event.peakProcessRssBytes ?? event.processRssBytes ?? 0),
        ...(event.workerHeapUsedBytes === undefined
          ? {}
          : { workerHeapPeakBytes: Number(event.workerHeapUsedBytes) }),
        spoolBytes: Number(event.spoolBytes ?? 0),
      }));
    const phases = new Set(events.map((event) => String(event.kind)));
    return new DaemonBenchmarkDiagnostics(
      operationMetrics,
      events.filter((event) => event.kind === "worker-replaced").length,
      events.filter((event) => event.failureCode === "response-capacity").length,
      events.filter((event) => event.kind === "process-termination").length,
      Math.max(0, ...operationMetrics.map((metric) => metric.processRssPeakBytes)),
      DaemonBenchmarkDiagnostics.maximumOptional(
        operationMetrics.map((metric) => metric.workerHeapPeakBytes),
      ),
      Math.max(0, ...operationMetrics.map((metric) => metric.spoolBytes)),
      [
        "startup-completed",
        "request-accepted",
        "turn-started",
        "worker-completed",
        "response-spooled",
        "execution-terminal",
        "delivery-terminal",
      ].every((phase) => phases.has(phase)),
    );
  }

  enrich(samples: readonly BenchmarkSampleEvidence[]): BenchmarkSampleEvidence[] {
    const available = [...this.operationMetrics];
    return samples.map((sample) => {
      const index = available.findIndex((metric) => metric.command === sample.command);
      if (index < 0) return sample;
      const [metric] = available.splice(index, 1);
      return {
        ...sample,
        serviceMsExcludingQueue: metric!.serviceMs,
        queueWaitMs: metric!.queueWaitMs,
        processRssPeakBytes: metric!.processRssPeakBytes,
        ...(metric!.workerHeapPeakBytes === undefined
          ? {}
          : { workerHeapPeakBytes: metric!.workerHeapPeakBytes }),
        spoolPeakBytes: metric!.spoolBytes,
      };
    });
  }

  complete(sampleCount: number): boolean {
    return this.operationMetrics.length >= sampleCount;
  }

  private static maximumOptional(values: readonly (number | undefined)[]): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length === 0 ? undefined : Math.max(...present);
  }
}
