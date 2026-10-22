import type { TestDaemonResourcePolicyRecord as DaemonResourcePolicyRecord } from "../helpers/daemon-resource-policy.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import { DAEMON_COMMAND_NAMES, type DaemonCommandName } from "@symnav/daemon";
import { DaemonTestingInspector } from "@symnav/daemon/testing";
import { TestDaemonResourcePolicy as DaemonResourcePolicy } from "../helpers/daemon-resource-policy.js";
import { InvocationWorkspaceSelector } from "../../src/invocation-workspace-selector.js";
import { StateDirectoryResolver } from "../../src/state-directory-resolver.js";
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
  type DaemonBenchmarkResultExpectation,
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
  readonly startupPhaseStatistics: Readonly<Record<string, DaemonBenchmarkDurationStatistics>>;
  readonly commandStatistics: Readonly<Record<string, DaemonBenchmarkStatistics>>;
  readonly commandPhaseStatistics: Readonly<Record<string, DaemonBenchmarkCommandPhaseStatistics>>;
  readonly processRssPeakBytes: number;
  readonly workerHeapPeakBytes?: number;
  readonly spoolPeakBytes: number;
  readonly responsePeakBytes: number;
  readonly largeResponseBytes: number;
  readonly busyStatusObserved: boolean;
  readonly statusMaximumMs: number;
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
      const canonicalRoot = canonicalWorkspaceRoot(realpathSync(workspaceRoot));
      const inspector = new DaemonTestingInspector(
        StateDirectoryResolver.canonicalize(stateDirectory),
      );
      const startupStartedAt = performance.now();
      const started = this.runCommand(workspaceRoot, stateDirectory, ["daemon", "start"], false);
      const startupMs = performance.now() - startupStartedAt;
      if (started.status !== 0)
        throw new Error(`Daemon benchmark startup failed: ${started.stderr}`);
      daemonStarted = true;
      const initialInstance = inspector
        .listInstances()
        .find((instance) => instance.workspaceRoot === canonicalRoot);
      if (initialInstance === undefined)
        throw new Error("Daemon benchmark startup record is missing");

      const fixedDiagnosticCursor = await this.waitForStartupDiagnostics(inspector, canonicalRoot);
      const samples = await this.runFixedSuite(generated, stateDirectory);
      const fixedDiagnostics = await this.waitForFixedDiagnostics(
        inspector,
        canonicalRoot,
        fixedDiagnosticCursor,
        samples.length,
      );
      const enrichedSamples = fixedDiagnostics.enrich(samples);
      const fixedArtifactComplete = fixedDiagnostics.complete(enrichedSamples);
      const mutations = this.runMutations(generated, stateDirectory);
      const largeResponse = await this.runLargeResponseAndBusyStatus(generated, stateDirectory);
      const finalInstance = inspector
        .listInstances()
        .find((instance) => instance.workspaceRoot === canonicalRoot);
      if (finalInstance === undefined) throw new Error("Daemon benchmark final record is missing");
      const stopped = this.runCommand(workspaceRoot, stateDirectory, ["daemon", "stop"], false);
      daemonStarted = false;
      if (stopped.status !== 0) throw new Error("Daemon benchmark shutdown failed");

      const diagnostics = DaemonBenchmarkDiagnostics.from(inspector.readDiagnostics(canonicalRoot));
      const telemetryCommands = this.warmTelemetryCommands(stateDirectory);
      const resourcePolicy = DaemonResourcePolicy.fromSystemMemory(
        totalmem(),
        process.constrainedMemory?.(),
      ).record;
      const expectedTelemetryCount = enrichedSamples.length + 7;
      const gate = new DaemonBenchmarkGate().evaluate({
        scale: this.options.scale,
        samples: enrichedSamples,
        expectedCommands: Object.keys(generated.commands) as (keyof typeof generated.commands)[],
        stdoutParity: samples.every((sample) => sample.stdoutParity) && largeResponse.stdoutParity,
        stderrParity: samples.every((sample) => sample.stderrParity) && largeResponse.stderrParity,
        exitParity: samples.every((sample) => sample.exitParity) && largeResponse.exitParity,
        semanticResultsValid: BenchmarkSampleEvidence.semanticResultsValid(samples),
        freshness: mutations.current,
        statusMaximumMs: largeResponse.statusMaximumMs,
        busyStatusObserved: largeResponse.busyStatusObserved,
        initialPid: initialInstance.pid,
        finalPid: finalInstance.pid,
        initialInstanceId: initialInstance.instanceId,
        finalInstanceId: finalInstance.instanceId,
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
          ...enrichedSamples.map((sample) => sample.command),
          "overview",
          "resolve",
          "resolve",
          "overview",
          "overview",
          "overview",
          "overview",
        ],
        actualTelemetryCommands: telemetryCommands,
        invocationTelemetryComplete:
          enrichedSamples.every((sample) => sample.telemetryMatched) &&
          mutations.telemetryComplete &&
          largeResponse.telemetryMatched,
        artifactComplete: fixedArtifactComplete,
        spoolBytesAfterCleanup: inspector.completionSpoolUsage(canonicalRoot).bytes,
        diagnosticPhasesComplete: diagnostics.phasesComplete,
        generatedVisibleFiles: generatedProfile.visibleTypeScriptFiles,
        expectedVisibleFiles: generated.expectedProfile.visibleTypeScriptFiles,
        mutationsCurrent: mutations.current,
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
        startupPhaseStatistics: DaemonBenchmarkPhaseStatistics.startup(
          diagnostics.startupDurations,
        ),
        commandStatistics: gate.commandStatistics,
        commandPhaseStatistics: DaemonBenchmarkPhaseStatistics.from(enrichedSamples),
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
        statusMaximumMs: largeResponse.statusMaximumMs,
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
        const telemetryBefore = this.telemetryEvents(stateDirectory);
        const startedAt = performance.now();
        const warm = await this.runCommandAsync(
          generated.workspaceRoot,
          stateDirectory,
          benchmark.argv,
          true,
          true,
        );
        const wallMs = performance.now() - startedAt;
        const telemetryAfter = this.telemetryEvents(stateDirectory);
        samples.push(
          BenchmarkSampleEvidence.from(
            command as keyof typeof generated.commands,
            repetition,
            cold,
            warm,
            wallMs,
            benchmark,
            BenchmarkSampleEvidence.telemetryMatched(
              telemetryBefore,
              telemetryAfter,
              command as keyof typeof generated.commands,
            ),
          ),
        );
      }
    }
    return samples;
  }

  private async waitForFixedDiagnostics(
    inspector: DaemonTestingInspector,
    canonicalWorkspaceRoot: string,
    cursor: number,
    expectedOperations: number,
  ): Promise<DaemonBenchmarkDiagnostics> {
    const deadline = performance.now() + 10_000;
    let diagnostics = DaemonBenchmarkDiagnostics.from(
      inspector.readDiagnostics(canonicalWorkspaceRoot),
      cursor,
    );
    while (!diagnostics.ready(expectedOperations) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      diagnostics = DaemonBenchmarkDiagnostics.from(
        inspector.readDiagnostics(canonicalWorkspaceRoot),
        cursor,
      );
    }
    return diagnostics;
  }

  private async waitForStartupDiagnostics(
    inspector: DaemonTestingInspector,
    canonicalWorkspaceRoot: string,
  ): Promise<number> {
    const deadline = performance.now() + 10_000;
    let page = inspector.readDiagnostics(canonicalWorkspaceRoot);
    while (
      !DaemonBenchmarkDiagnostics.startupProbeComplete(page.events) &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      page = inspector.readDiagnostics(canonicalWorkspaceRoot);
    }
    return page.nextCursor;
  }

  private runMutations(
    generated: GeneratedDaemonWorkspace,
    stateDirectory: string,
  ): MutationEvidence {
    const root = generated.workspaceRoot;
    let current = true;
    const telemetryMatches: boolean[] = [];
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
    const editedEvidence = this.changedParity(
      root,
      stateDirectory,
      generated.commands.overview.argv,
      beforeEdit,
    );
    current = editedEvidence.current && current;
    telemetryMatches.push(editedEvidence.telemetryMatched);

    const addedPath = join(root, generated.mutations.add);
    writeFileSync(addedPath, "export const AddedBenchmarkSymbol = 1;\n", "utf8");
    const addedEvidence = this.nonEmptyParity(root, stateDirectory, [
      "resolve",
      "AddedBenchmarkSymbol",
    ]);
    current = addedEvidence.current && current;
    telemetryMatches.push(addedEvidence.telemetryMatched);

    const beforeRemove = this.runCommand(
      root,
      stateDirectory,
      ["resolve", generated.mutations.removeSymbol],
      false,
    );
    unlinkSync(join(root, generated.mutations.remove));
    const removedEvidence = this.changedParity(
      root,
      stateDirectory,
      ["resolve", generated.mutations.removeSymbol],
      beforeRemove,
    );
    current = removedEvidence.current && current;
    telemetryMatches.push(removedEvidence.telemetryMatched);

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
    const renamedEvidence = this.nonEmptyParity(root, stateDirectory, [
      "overview",
      generated.mutations.renameTo,
    ]);
    current = renamedEvidence.current && beforeRename.status === 0 && current;
    telemetryMatches.push(renamedEvidence.telemetryMatched);

    const beforeIgnore = this.runCommand(
      root,
      stateDirectory,
      ["overview", generated.mutations.add],
      false,
    );
    appendFileSync(join(root, generated.mutations.ignoreRule), `${generated.mutations.add}\n`);
    const ignoredEvidence = this.changedParity(
      root,
      stateDirectory,
      ["overview", generated.mutations.add],
      beforeIgnore,
    );
    current = ignoredEvidence.current && current;
    telemetryMatches.push(ignoredEvidence.telemetryMatched);
    const nestedEvidence = this.errorParity(root, stateDirectory, [
      "overview",
      generated.mutations.nestedWorkspaceFile,
    ]);
    current = nestedEvidence.current && current;
    telemetryMatches.push(nestedEvidence.telemetryMatched);
    return { current, telemetryComplete: telemetryMatches.every(Boolean) };
  }

  private changedParity(
    root: string,
    stateDirectory: string,
    argv: readonly string[],
    before: RunSymnavBinaryResult,
  ): MutationInvocationEvidence {
    const result = this.parity(root, stateDirectory, argv);
    return {
      current: result.parity && result.cold.stdout !== before.stdout,
      telemetryMatched: result.telemetryMatched,
    };
  }

  private nonEmptyParity(
    root: string,
    stateDirectory: string,
    argv: readonly string[],
  ): MutationInvocationEvidence {
    const result = this.parity(root, stateDirectory, argv);
    return {
      current: result.parity && result.warm.status === 0 && result.warm.stdout.trim().length > 0,
      telemetryMatched: result.telemetryMatched,
    };
  }

  private errorParity(
    root: string,
    stateDirectory: string,
    argv: readonly string[],
  ): MutationInvocationEvidence {
    const result = this.parity(root, stateDirectory, argv);
    return {
      current: result.parity && result.warm.status !== 0,
      telemetryMatched: result.telemetryMatched,
    };
  }

  private parity(
    root: string,
    stateDirectory: string,
    argv: readonly string[],
  ): {
    readonly cold: RunSymnavBinaryResult;
    readonly warm: RunSymnavBinaryResult;
    readonly parity: boolean;
    readonly telemetryMatched: boolean;
  } {
    const cold = this.runCommand(root, stateDirectory, argv, false);
    const telemetryBefore = this.telemetryEvents(stateDirectory);
    const warm = this.runCommand(root, stateDirectory, argv, true);
    const telemetryAfter = this.telemetryEvents(stateDirectory);
    const route = new InvocationWorkspaceSelector().select(argv, root).route;
    if (route.kind !== "workspace") throw new Error("Benchmark command must select a workspace");
    return {
      cold,
      warm,
      parity:
        cold.status === warm.status && cold.stdout === warm.stdout && cold.stderr === warm.stderr,
      telemetryMatched: BenchmarkInvocationTelemetry.matches({
        before: telemetryBefore,
        after: telemetryAfter,
        command: route.commandName,
      }),
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
    const telemetryBefore = this.telemetryEvents(stateDirectory);
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
    const telemetryAfter = this.telemetryEvents(stateDirectory);
    unlinkSync(sourcePath);
    return {
      responseBytes: Buffer.byteLength(warm.stdout) + Buffer.byteLength(warm.stderr),
      stdoutParity: cold.stdout === warm.stdout,
      stderrParity: cold.stderr === warm.stderr,
      exitParity: cold.status === warm.status,
      busyStatusObserved,
      statusMaximumMs,
      telemetryMatched: BenchmarkInvocationTelemetry.matches({
        before: telemetryBefore,
        after: telemetryAfter,
        command: "overview",
      }),
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
      .map((event) => event.command)
      .filter((command): command is DaemonCommandName =>
        DAEMON_COMMAND_NAMES.includes(command as DaemonCommandName),
      );
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
}

export interface BenchmarkSampleEvidence extends DaemonBenchmarkSample {
  readonly stdoutParity: boolean;
  readonly stderrParity: boolean;
  readonly exitParity: boolean;
  readonly nonEmpty: boolean;
  readonly diagnosticMatched: boolean;
  readonly telemetryMatched: boolean;
}

interface LargeResponseEvidence {
  readonly responseBytes: number;
  readonly stdoutParity: boolean;
  readonly stderrParity: boolean;
  readonly exitParity: boolean;
  readonly busyStatusObserved: boolean;
  readonly statusMaximumMs: number;
  readonly telemetryMatched: boolean;
}

interface MutationEvidence {
  readonly current: boolean;
  readonly telemetryComplete: boolean;
}

interface MutationInvocationEvidence {
  readonly current: boolean;
  readonly telemetryMatched: boolean;
}

interface BenchmarkTelemetryWindow {
  readonly before: readonly Record<string, unknown>[];
  readonly after: readonly Record<string, unknown>[];
  readonly command: DaemonCommandName;
}

export class BenchmarkInvocationTelemetry {
  static complete(windows: readonly BenchmarkTelemetryWindow[]): boolean {
    return windows.every((window) => this.matches(window));
  }

  static matches(window: BenchmarkTelemetryWindow): boolean {
    const appended = window.after.slice(window.before.length);
    return (
      window.after.length === window.before.length + 1 &&
      appended[0]?.command === window.command &&
      appended[0]?.executionMode === "warm"
    );
  }
}

export class BenchmarkSampleEvidence {
  static semanticResultsValid(samples: readonly BenchmarkSampleEvidence[]): boolean {
    return samples.every((sample) => sample.nonEmpty);
  }

  static telemetryMatched(
    before: readonly Record<string, unknown>[],
    after: readonly Record<string, unknown>[],
    command: DaemonCommandName,
  ): boolean {
    return BenchmarkInvocationTelemetry.matches({ before, after, command });
  }

  static from(
    command: keyof GeneratedDaemonWorkspace["commands"],
    repetition: number,
    cold: RunSymnavBinaryResult,
    warm: RunSymnavBinaryResult,
    wallMs: number,
    benchmark: DaemonBenchmarkCommand,
    telemetryMatched = true,
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
      freshnessMs: 0,
      navigationMs: 0,
      renderMs: 0,
      workerOutputMs: 0,
      spoolMs: 0,
      stdoutParity: cold.stdout === warm.stdout,
      stderrParity: cold.stderr === warm.stderr,
      exitParity: cold.status === warm.status,
      nonEmpty:
        !benchmark.expectNonEmpty ||
        (warm.status === 0 &&
          warm.stdout.trim().length > 0 &&
          DaemonBenchmarkSemanticResult.matches(benchmark.expectation, warm.stdout)),
      diagnosticMatched: false,
      telemetryMatched,
    };
  }

  private static digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

export class DaemonBenchmarkSemanticResult {
  static matches(
    expectation: DaemonBenchmarkResultExpectation | undefined,
    stdout: string,
  ): boolean {
    if (expectation === undefined) return stdout.trim().length > 0;
    let result: Record<string, unknown>;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (!this.isRecord(parsed)) return false;
      result = parsed;
    } catch {
      return false;
    }
    if (expectation.kind === "overview") {
      return this.arrayLength(result.entries) === expectation.symbols;
    }
    if (expectation.kind === "resolve" || expectation.kind === "definition") {
      return this.arrayLength(result.symbols) === expectation.symbols;
    }
    if (expectation.kind === "references") return result.total === expectation.total;
    if (expectation.kind === "context") {
      return (
        this.edgeCount(result.callers) === expectation.callers &&
        this.edgeCount(result.callees) === expectation.callees &&
        this.arrayLength(result.history) === expectation.history
      );
    }
    if (expectation.kind === "graph") {
      return (
        this.pathCount(result.incoming) === expectation.incomingPaths &&
        this.pathCount(result.outgoing) === expectation.outgoingPaths
      );
    }
    return (
      typeof result.totalEvents === "number" &&
      Array.isArray(result.perCommand) &&
      Array.isArray(result.outcomes) &&
      this.isRecord(result.duration)
    );
  }

  private static edgeCount(value: unknown): number {
    if (!this.isRecord(value)) return -1;
    const visible = this.arrayLength(value.sortedEdges);
    const omitted = value.omittedCertainEdgeCount;
    return visible < 0 || typeof omitted !== "number" ? -1 : visible + omitted;
  }

  private static pathCount(value: unknown): number {
    if (!this.isRecord(value) || typeof value.totalPathCount !== "number") return -1;
    return value.totalPathCount;
  }

  private static arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : -1;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

interface OperationMetrics {
  readonly requestId: string;
  readonly command: string;
  readonly queueWaitMs: number;
  readonly serviceMs: number;
  readonly processRssPeakBytes: number;
  readonly workerHeapPeakBytes?: number;
  readonly spoolBytes: number;
  readonly freshnessMs: number;
  readonly navigationMs: number;
  readonly renderMs: number;
  readonly workerOutputMs: number;
  readonly spoolMs: number;
  readonly complete: boolean;
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
    readonly startupDurations: {
      readonly discoveryMs: number;
      readonly indexingMs: number;
      readonly totalMs: number;
    },
    private readonly uncorrelatedOperationEventCount: number,
  ) {}

  static from(
    page: import("@symnav/daemon/testing").DaemonTestingDiagnosticPage,
    cursor = 0,
  ): DaemonBenchmarkDiagnostics {
    const allEvents = page.events;
    const events = allEvents.slice(cursor);
    const accepted = events.filter((event) => event.kind === "request-accepted");
    const acceptedRequestIds = new Set(accepted.map((event) => String(event.requestId)));
    const operationKinds = new Set([
      "turn-started",
      "worker-completed",
      "response-spooled",
      "execution-terminal",
      "delivery-terminal",
    ]);
    const uncorrelatedOperationEventCount = events.filter(
      (event) =>
        operationKinds.has(String(event.kind)) && !acceptedRequestIds.has(String(event.requestId)),
    ).length;
    const operationMetrics = accepted.map((acceptedEvent) => {
      const requestId = String(acceptedEvent.requestId);
      const requestEvents = events.filter((event) => String(event.requestId) === requestId);
      const acceptedEvents = requestEvents.filter((event) => event.kind === "request-accepted");
      const turns = requestEvents.filter((event) => event.kind === "turn-started");
      const workers = requestEvents.filter((event) => event.kind === "worker-completed");
      const spools = requestEvents.filter((event) => event.kind === "response-spooled");
      const terminals = requestEvents.filter((event) => event.kind === "execution-terminal");
      const deliveries = requestEvents.filter((event) => event.kind === "delivery-terminal");
      const turn = turns[0];
      const spool = spools[0];
      const terminal = terminals[0];
      const worker = workers[0];
      return {
        requestId,
        command: String(acceptedEvent.command),
        queueWaitMs: Number(turn?.queueWaitMs ?? 0),
        serviceMs: Number(terminal?.serviceMs ?? 0),
        processRssPeakBytes: Number(
          terminal?.peakProcessRssBytes ?? terminal?.processRssBytes ?? 0,
        ),
        ...(terminal?.peakWorkerHeapUsedBytes === undefined
          ? {}
          : { workerHeapPeakBytes: Number(terminal.peakWorkerHeapUsedBytes) }),
        spoolBytes: Math.max(Number(terminal?.spoolBytes ?? 0), Number(spool?.rawBytes ?? 0)),
        freshnessMs: Number(worker?.freshnessMs ?? 0),
        navigationMs: Number(worker?.navigationMs ?? 0),
        renderMs: Number(worker?.renderMs ?? 0),
        workerOutputMs: Number(worker?.workerOutputMs ?? 0),
        spoolMs: Number(spool?.spoolMs ?? 0),
        complete:
          acceptedEvents.length === 1 &&
          turns.length === 1 &&
          workers.length === 1 &&
          spools.length === 1 &&
          terminals.length === 1 &&
          deliveries.length === 1 &&
          terminals[0]?.outcome === "completed" &&
          deliveries[0]?.outcome === "delivered",
      };
    });
    const phases = new Set(events.map((event) => String(event.kind)));
    const startup = allEvents.filter((event) => event.kind === "startup-completed");
    const startupEvent = startup[0];
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
      ].every((phase) => phases.has(phase)) && startup.length === 1,
      {
        discoveryMs: Number(startupEvent?.discoveryMs ?? 0),
        indexingMs: Number(startupEvent?.indexingMs ?? 0),
        totalMs: Number(startupEvent?.totalMs ?? 0),
      },
      uncorrelatedOperationEventCount,
    );
  }

  static startupProbeComplete(
    events: readonly import("@symnav/daemon/testing").DaemonTestingDiagnosticEvent[],
  ): boolean {
    const versionRequests = new Set(
      events
        .filter((event) => event.kind === "request-accepted" && event.command === "version")
        .map((event) => String(event.requestId)),
    );
    return (
      events.some((event) => event.kind === "startup-completed") &&
      events.some(
        (event) =>
          event.kind === "delivery-terminal" &&
          event.outcome === "delivered" &&
          versionRequests.has(String(event.requestId)),
      )
    );
  }

  enrich(samples: readonly BenchmarkSampleEvidence[]): BenchmarkSampleEvidence[] {
    return samples.map((sample, index) => {
      const metric = this.operationMetrics[index];
      if (metric === undefined || metric.command !== sample.command || !metric.complete)
        return sample;
      return {
        ...sample,
        serviceMsExcludingQueue: metric!.serviceMs,
        queueWaitMs: metric!.queueWaitMs,
        processRssPeakBytes: metric!.processRssPeakBytes,
        ...(metric!.workerHeapPeakBytes === undefined
          ? {}
          : { workerHeapPeakBytes: metric!.workerHeapPeakBytes }),
        spoolPeakBytes: metric!.spoolBytes,
        freshnessMs: metric!.freshnessMs,
        navigationMs: metric!.navigationMs,
        renderMs: metric!.renderMs,
        workerOutputMs: metric!.workerOutputMs,
        spoolMs: metric!.spoolMs,
        diagnosticMatched: true,
      };
    });
  }

  complete(samples: readonly BenchmarkSampleEvidence[]): boolean {
    return (
      this.uncorrelatedOperationEventCount === 0 &&
      this.operationMetrics.length === samples.length &&
      this.operationMetrics.every((metric) => metric.complete) &&
      samples.every((sample) => sample.diagnosticMatched)
    );
  }

  ready(expectedOperations: number): boolean {
    return (
      this.uncorrelatedOperationEventCount === 0 &&
      this.operationMetrics.length === expectedOperations &&
      this.operationMetrics.every((metric) => metric.complete)
    );
  }

  private static maximumOptional(values: readonly (number | undefined)[]): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length === 0 ? undefined : Math.max(...present);
  }
}

export interface DaemonBenchmarkDurationStatistics {
  readonly minimumMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

export interface DaemonBenchmarkCommandPhaseStatistics {
  readonly freshness: DaemonBenchmarkDurationStatistics;
  readonly navigation: DaemonBenchmarkDurationStatistics;
  readonly render: DaemonBenchmarkDurationStatistics;
  readonly workerOutput: DaemonBenchmarkDurationStatistics;
  readonly spool: DaemonBenchmarkDurationStatistics;
}

export class DaemonBenchmarkPhaseStatistics {
  static from(
    samples: readonly BenchmarkSampleEvidence[],
  ): Readonly<Record<string, DaemonBenchmarkCommandPhaseStatistics>> {
    const statistics: Record<string, DaemonBenchmarkCommandPhaseStatistics> = {};
    for (const command of new Set(samples.map((sample) => sample.command))) {
      const commandSamples = samples.filter((sample) => sample.command === command);
      statistics[command] = {
        freshness: this.distribution(commandSamples.map((sample) => sample.freshnessMs)),
        navigation: this.distribution(commandSamples.map((sample) => sample.navigationMs)),
        render: this.distribution(commandSamples.map((sample) => sample.renderMs)),
        workerOutput: this.distribution(commandSamples.map((sample) => sample.workerOutputMs)),
        spool: this.distribution(commandSamples.map((sample) => sample.spoolMs)),
      };
    }
    return statistics;
  }

  static startup(durations: {
    readonly discoveryMs: number;
    readonly indexingMs: number;
    readonly totalMs: number;
  }): Readonly<Record<string, DaemonBenchmarkDurationStatistics>> {
    return {
      discovery: this.distribution([durations.discoveryMs]),
      indexing: this.distribution([durations.indexingMs]),
      total: this.distribution([durations.totalMs]),
    };
  }

  private static distribution(values: readonly number[]): DaemonBenchmarkDurationStatistics {
    const ordered = [...values].sort((left, right) => left - right);
    return {
      minimumMs: ordered[0]!,
      p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1]!,
      p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1]!,
      maximumMs: ordered.at(-1)!,
    };
  }
}
