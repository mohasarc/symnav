import type { DaemonResourcePolicyRecord } from "../../src/daemon/daemon-resource-monitor.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm as remove } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { canonicalStateDir } from "@symnav/telemetry";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import type { DaemonCommandName } from "../../src/daemon/daemon-protocol.js";
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
  readonly largeResponseBytes: number;
  readonly busyStatusObserved: boolean;
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

      const samples = await this.runFixedSuite(generated, stateDirectory);
      const fixedDiagnostics = DaemonBenchmarkDiagnostics.read(identity.logPath);
      const enrichedSamples = fixedDiagnostics.enrich(samples);
      const fixedArtifactComplete = fixedDiagnostics.complete(enrichedSamples);
      const freshness = this.runMutations(generated, stateDirectory);
      const largeResponse = await this.runLargeResponseAndBusyStatus(generated, stateDirectory);
      const finalRecord = registry.read(identity);
      if (finalRecord === undefined) throw new Error("Daemon benchmark final record is missing");
      const stopped = this.runCommand(workspaceRoot, stateDirectory, ["daemon", "stop"], false);
      daemonStarted = false;
      if (stopped.status !== 0) throw new Error("Daemon benchmark shutdown failed");

      const diagnostics = DaemonBenchmarkDiagnostics.read(identity.logPath);
      const telemetryCommands = this.warmTelemetryCommands(stateDirectory);
      const resourcePolicy = DaemonResourcePolicy.fromSystemMemory(
        totalmem(),
        process.constrainedMemory?.(),
      ).record;
      const expectedTelemetryCount =
        enrichedSamples.filter((sample) => sample.command !== "stats").length + 7;
      const gate = new DaemonBenchmarkGate().evaluate({
        scale: this.options.scale,
        samples: enrichedSamples,
        expectedCommands: Object.keys(generated.commands) as (keyof typeof generated.commands)[],
        stdoutParity: samples.every((sample) => sample.stdoutParity) && largeResponse.stdoutParity,
        stderrParity: samples.every((sample) => sample.stderrParity) && largeResponse.stderrParity,
        exitParity: samples.every((sample) => sample.exitParity) && largeResponse.exitParity,
        aliasResultsNonEmpty: samples
          .filter((sample) =>
            ["resolve", "def", "refs", "context", "graph"].includes(sample.command),
          )
          .every((sample) => sample.nonEmpty),
        freshness,
        statusMaximumMs: largeResponse.statusMaximumMs,
        busyStatusObserved: largeResponse.busyStatusObserved,
        initialPid: initialRecord.pid,
        finalPid: finalRecord.pid,
        initialInstanceId: initialRecord.instanceId,
        finalInstanceId: finalRecord.instanceId,
        fallbackCount: this.fallbackTelemetryCount(stateDirectory),
        restartCount: diagnostics.restartCount,
        capacityResultCount: diagnostics.capacityResultCount,
        rawRuntimeFailureCount: diagnostics.rawRuntimeFailureCount,
        largeResponseBytes: largeResponse.responseBytes,
        processRssPeakBytes: diagnostics.processRssPeakBytes,
        hardProcessRssBytes: resourcePolicy.hardProcessRssBytes,
        expectedTelemetryCount,
        actualTelemetryCount: telemetryCommands.length,
        expectedTelemetryCommands: [
          ...enrichedSamples
            .filter((sample) => sample.command !== "stats")
            .map((sample) => sample.command),
          "overview",
          "resolve",
          "resolve",
          "overview",
          "overview",
          "overview",
          "overview",
        ],
        actualTelemetryCommands: telemetryCommands,
        artifactComplete: fixedArtifactComplete,
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
        responsePeakBytes: Math.max(
          largeResponse.responseBytes,
          ...enrichedSamples.map((sample) => sample.responseBytes),
        ),
        largeResponseBytes: largeResponse.responseBytes,
        busyStatusObserved: largeResponse.busyStatusObserved,
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
        this.runCommand(workspaceRoot, stateDirectory, ["daemon", "stop"], false);
      }
      if (ownsWorkspace) await DaemonScaleBenchmarkHarness.removeOwnedDirectory(workspaceRoot);
      if (ownsState) await DaemonScaleBenchmarkHarness.removeOwnedDirectory(stateDirectory);
    }
  }

  private async runFixedSuite(
    generated: GeneratedDaemonWorkspace,
    stateDirectory: string,
  ): Promise<BenchmarkSampleEvidence[]> {
    const samples: BenchmarkSampleEvidence[] = [];
    for (const [command, benchmark] of Object.entries(generated.commands)) {
      const cold = await this.runCommandAsync(
        generated.workspaceRoot,
        stateDirectory,
        benchmark.argv,
        false,
        false,
      );
      for (let repetition = 0; repetition < DAEMON_BENCHMARK_WARM_REPETITIONS; repetition += 1) {
        const startedAt = performance.now();
        const warm = await this.runCommandAsync(
          generated.workspaceRoot,
          stateDirectory,
          benchmark.argv,
          true,
          true,
        );
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
    const originalTimes = statSync(editedPath);
    const beforeEdit = this.runCommand(
      root,
      stateDirectory,
      generated.commands.overview.argv,
      false,
    );
    const edited = original.replace(/generatorSeed = "[0-9a-f]/, (prefix) =>
      prefix.endsWith("0") ? `${prefix.slice(0, -1)}1` : `${prefix.slice(0, -1)}0`,
    );
    writeFileSync(editedPath, edited, "utf8");
    utimesSync(editedPath, originalTimes.atime, originalTimes.mtime);
    current =
      this.changedParity(root, stateDirectory, generated.commands.overview.argv, beforeEdit) &&
      current;

    const addedPath = join(root, generated.mutations.add);
    writeFileSync(addedPath, "export const AddedBenchmarkSymbol = 1;\n", "utf8");
    current =
      this.nonEmptyParity(root, stateDirectory, ["resolve", "AddedBenchmarkSymbol"]) && current;

    const beforeRemove = this.runCommand(
      root,
      stateDirectory,
      ["resolve", generated.mutations.removeSymbol],
      false,
    );
    unlinkSync(join(root, generated.mutations.remove));
    current =
      this.changedParity(
        root,
        stateDirectory,
        ["resolve", generated.mutations.removeSymbol],
        beforeRemove,
      ) && current;

    const beforeRename = this.runCommand(
      root,
      stateDirectory,
      ["overview", generated.mutations.renameFrom],
      false,
    );
    renameSync(
      join(root, generated.mutations.renameFrom),
      join(root, generated.mutations.renameTo),
    );
    current =
      this.nonEmptyParity(root, stateDirectory, ["overview", generated.mutations.renameTo]) &&
      beforeRename.status === 0 &&
      current;

    const beforeIgnore = this.runCommand(
      root,
      stateDirectory,
      ["overview", generated.mutations.add],
      false,
    );
    appendFileSync(join(root, generated.mutations.ignoreRule), `${generated.mutations.add}\n`);
    current =
      this.changedParity(
        root,
        stateDirectory,
        ["overview", generated.mutations.add],
        beforeIgnore,
      ) && current;
    current =
      this.errorParity(root, stateDirectory, [
        "overview",
        generated.mutations.nestedWorkspaceFile,
      ]) && current;
    return current;
  }

  private changedParity(
    root: string,
    stateDirectory: string,
    argv: readonly string[],
    before: RunSymnavBinaryResult,
  ): boolean {
    const result = this.parity(root, stateDirectory, argv);
    return result.parity && result.cold.stdout !== before.stdout;
  }

  private nonEmptyParity(root: string, stateDirectory: string, argv: readonly string[]): boolean {
    const result = this.parity(root, stateDirectory, argv);
    return result.parity && result.warm.status === 0 && result.warm.stdout.trim().length > 0;
  }

  private errorParity(root: string, stateDirectory: string, argv: readonly string[]): boolean {
    const result = this.parity(root, stateDirectory, argv);
    return result.parity && result.warm.status !== 0;
  }

  private parity(
    root: string,
    stateDirectory: string,
    argv: readonly string[],
  ): {
    readonly cold: RunSymnavBinaryResult;
    readonly warm: RunSymnavBinaryResult;
    readonly parity: boolean;
  } {
    const cold = this.runCommand(root, stateDirectory, argv, false);
    const warm = this.runCommand(root, stateDirectory, argv, true);
    return {
      cold,
      warm,
      parity:
        cold.status === warm.status && cold.stdout === warm.stdout && cold.stderr === warm.stderr,
    };
  }

  private async runLargeResponseAndBusyStatus(
    generated: GeneratedDaemonWorkspace,
    stateDirectory: string,
  ): Promise<LargeResponseEvidence> {
    const relativePath = "large-response.ts";
    const sourcePath = join(generated.workspaceRoot, relativePath);
    const longType = `"${"x".repeat(90_000)}"`;
    const declarations = Array.from(
      { length: 100 },
      (_, index) =>
        `export function largeSymbol${String(index).padStart(5, "0")}(value: ${longType}): string { return value; }\n`,
    );
    writeFileSync(sourcePath, declarations.join(""), "utf8");
    const argv = ["overview", relativePath] as const;
    const cold = await this.runCommandAsync(
      generated.workspaceRoot,
      stateDirectory,
      argv,
      false,
      false,
    );
    let warmSettled = false;
    const warmPromise = this.runCommandAsync(
      generated.workspaceRoot,
      stateDirectory,
      argv,
      true,
      true,
    ).finally(() => {
      warmSettled = true;
    });
    let busyStatusObserved = false;
    let statusMaximumMs = 0;
    while (!busyStatusObserved && !warmSettled) {
      const statusStartedAt = performance.now();
      const status = this.runCommand(
        generated.workspaceRoot,
        stateDirectory,
        ["daemon", "status", "--json"],
        false,
      );
      statusMaximumMs = Math.max(statusMaximumMs, performance.now() - statusStartedAt);
      if (status.status !== 0) throw new Error("Daemon benchmark busy status failed");
      busyStatusObserved = DaemonScaleBenchmarkHarness.hasBusyDaemon(status.stdout);
      if (!busyStatusObserved) await DaemonScaleBenchmarkHarness.yieldToChild();
    }
    const warm = await warmPromise;
    unlinkSync(sourcePath);
    return {
      responseBytes: Buffer.byteLength(warm.stdout) + Buffer.byteLength(warm.stderr),
      stdoutParity: cold.stdout === warm.stdout,
      stderrParity: cold.stderr === warm.stderr,
      exitParity: cold.status === warm.status,
      busyStatusObserved,
      statusMaximumMs,
    };
  }

  private runCommandAsync(
    workspaceRoot: string,
    stateDirectory: string,
    argv: readonly string[],
    daemon: boolean,
    telemetry: boolean,
  ): Promise<RunSymnavBinaryResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [DaemonScaleBenchmarkHarness.cliPath, ...argv], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          SYMNAV_STATE_DIR: stateDirectory,
          SYMNAV_DAEMON: daemon ? "1" : "0",
          SYMNAV_TELEMETRY: telemetry ? "1" : "0",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (status) => resolveResult({ status, stdout, stderr }));
    });
  }

  private static get cliPath(): string {
    return fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  }

  private static hasBusyDaemon(stdout: string): boolean {
    const value = JSON.parse(stdout) as { daemons?: readonly { state?: unknown }[] };
    return value.daemons?.some((daemon) => daemon.state === "busy") ?? false;
  }

  private static yieldToChild(): Promise<void> {
    return new Promise((resolveYield) => setTimeout(resolveYield, 10));
  }

  private static async removeOwnedDirectory(path: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await remove(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
      }
    }
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

  private warmTelemetryCommands(stateDirectory: string): DaemonCommandName[] {
    return this.telemetryEvents(stateDirectory)
      .filter((event) => event.executionMode === "warm")
      .map((event) => event.command as DaemonCommandName);
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

export interface BenchmarkSampleEvidence extends DaemonBenchmarkSample {
  readonly stdoutParity: boolean;
  readonly stderrParity: boolean;
  readonly exitParity: boolean;
  readonly nonEmpty: boolean;
  readonly diagnosticMatched: boolean;
}

interface LargeResponseEvidence {
  readonly responseBytes: number;
  readonly stdoutParity: boolean;
  readonly stderrParity: boolean;
  readonly exitParity: boolean;
  readonly busyStatusObserved: boolean;
  readonly statusMaximumMs: number;
}

export class BenchmarkSampleEvidence {
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
      diagnosticMatched: false,
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

export class DaemonBenchmarkDiagnostics {
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
    const spooledBytes = new Map<string, number>();
    for (const event of events) {
      if (event.kind === "request-accepted")
        commands.set(String(event.requestId), String(event.command));
      if (event.kind === "turn-started")
        queueWaits.set(String(event.requestId), Number(event.queueWaitMs));
      if (event.kind === "response-spooled")
        spooledBytes.set(String(event.requestId), Number(event.rawBytes));
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
        spoolBytes: Math.max(
          Number(event.spoolBytes ?? 0),
          spooledBytes.get(String(event.requestId)) ?? 0,
        ),
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
        diagnosticMatched: true,
      };
    });
  }

  complete(samples: readonly BenchmarkSampleEvidence[]): boolean {
    return samples.every((sample) => sample.diagnosticMatched);
  }

  private static maximumOptional(values: readonly (number | undefined)[]): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length === 0 ? undefined : Math.max(...present);
  }
}
