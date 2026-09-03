import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface DaemonPackageManifest {
  readonly name: string;
  readonly private: boolean;
  readonly type: string;
  readonly main: string;
  readonly types: string;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, unknown>>;
  readonly bundledDependencies?: readonly string[];
  readonly bundleDependencies?: readonly string[];
}

class DaemonPackageMetadata {
  public static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  public static readonly packageRoot = join(DaemonPackageMetadata.repoRoot, "packages/daemon");

  public static manifest(): DaemonPackageManifest {
    return JSON.parse(
      readFileSync(join(DaemonPackageMetadata.packageRoot, "package.json"), "utf8"),
    ) as DaemonPackageManifest;
  }

  public static productionDependencyNames(manifest: DaemonPackageManifest): readonly string[] {
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.peerDependenciesMeta ?? {}),
      ...(manifest.bundledDependencies ?? []),
      ...(manifest.bundleDependencies ?? []),
    ].sort();
  }

  public static policyDocument(): string {
    return readFileSync(join(DaemonPackageMetadata.repoRoot, "plans/005/daemon-policy.md"), "utf8");
  }

  public static appProductionSources(): string {
    const sourceRoot = join(DaemonPackageMetadata.repoRoot, "apps/cli/src");
    return DaemonPackageMetadata.files(sourceRoot)
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
  }

  private static files(directory: string): readonly string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? DaemonPackageMetadata.files(path) : [path];
    });
  }
}

describe("@symnav/daemon package boundary", () => {
  it("has the exact private ESM root and temporary policy-testing exports", () => {
    const manifest = DaemonPackageMetadata.manifest();
    expect({
      name: manifest.name,
      private: manifest.private,
      type: manifest.type,
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports,
    }).toEqual({
      name: "@symnav/daemon",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        "./policy-testing": {
          types: "./dist/policy-testing.d.ts",
          default: "./dist/policy-testing.js",
        },
      },
    });
    expect(Object.keys(manifest.exports)).toEqual([".", "./policy-testing"]);
  });

  it("has zero internal packages in every production dependency field", () => {
    const names = DaemonPackageMetadata.productionDependencyNames(DaemonPackageMetadata.manifest());
    expect(names.filter((name) => name.startsWith("@symnav/"))).toEqual([]);
  });

  it("proves every supported production dependency field is inspected", () => {
    const manifest: DaemonPackageManifest = {
      name: "fixture",
      private: true,
      type: "module",
      main: "index.js",
      types: "index.d.ts",
      exports: {},
      dependencies: { "@symnav/dependency": "workspace:*" },
      optionalDependencies: { "@symnav/optional": "workspace:*" },
      peerDependencies: { "@symnav/peer": "workspace:*" },
      peerDependenciesMeta: { "@symnav/peer-meta": {} },
      bundledDependencies: ["@symnav/bundled"],
      bundleDependencies: ["@symnav/bundle"],
    };
    expect(DaemonPackageMetadata.productionDependencyNames(manifest)).toEqual([
      "@symnav/bundle",
      "@symnav/bundled",
      "@symnav/dependency",
      "@symnav/optional",
      "@symnav/peer",
      "@symnav/peer-meta",
    ]);
  });

  it("documents every policy leaf and derivation exactly once", () => {
    const expectedRows = [
      "delivery.postAcceptanceExecutionReattachmentLimit",
      "delivery.resultTransferResumeLimitPerExecutionAttempt",
      "diagnostics.disconnectedTraceRetentionMs",
      "diagnostics.logBackupCount",
      "diagnostics.logRotateBytes",
      "diagnostics.maximumDisconnectedTraces",
      "diagnostics.maximumQueuedEvents",
      "output.inlineRawBytes",
      "output.maximumAggregateSpoolRawBytes",
      "output.maximumChunkRawBytes",
      "output.maximumResultRawBytes",
      "recipe.effectiveMemoryMiB",
      "recipe.effectiveMemorySelection",
      "recipe.forcedTerminationReserve",
      "recipe.hardProcessRss",
      "recipe.workerOldGeneration",
      "resources.effectiveMemoryBytes",
      "resources.hardProcessRssBytes",
      "resources.replacementLimit",
      "resources.replacementWindowMs",
      "resources.resumeProcessRssBytes",
      "resources.softProcessRssBytes",
      "resources.supervisionIntervalMs",
      "resources.workerHeapSampleIntervalMs",
      "resources.workerMaxOldGenerationSizeMiB",
      "shutdown.controllerPollIntervalMs",
      "shutdown.forcedTerminationReserveMaximumMs",
      "shutdown.idleTimeoutMs",
      "shutdown.processExitPollIntervalMs",
      "shutdown.processSignalExitTimeoutMs",
      "shutdown.resourceDrainAcknowledgementGraceMs",
      "shutdown.resourceDrainAcknowledgementPollIntervalMs",
      "shutdown.stopTimeoutMs",
      "startup.authorizationPollIntervalMs",
      "startup.childFailureRetryLimit",
      "startup.coordinationGraceMs",
      "startup.heartbeatIntervalMs",
      "startup.observationPollIntervalMs",
      "startup.previousInstanceTerminationTimeoutMs",
      "transport.executionAdmissionTimeoutMs",
      "transport.maximumExecutionControlPayloadBytes",
      "transport.maximumJsonPayloadBytes",
      "transport.singleResponseTimeoutMs",
      "transport.statusResponseTimeoutMs",
    ];
    const document = DaemonPackageMetadata.policyDocument();
    const rows = [...document.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual(expectedRows);
    expect(document).toContain(
      "| Policy path or recipe | Default or derivation | Applies to | Reason | Behavior oracle |",
    );
    expect(document).toContain("Phase 26 removes `@symnav/daemon/policy-testing`");
  });

  it("documents intentional deadline absences", () => {
    const document = DaemonPackageMetadata.policyDocument();
    for (const absence of [
      "healthy startup",
      "startup silence",
      "post-accept completion",
      "worker output acknowledgement",
      "unacknowledged result",
    ]) {
      expect(document).toContain(`| ${absence} | None |`);
    }
  });

  it("retires scattered operational defaults and policy bypasses", () => {
    const sources = DaemonPackageMetadata.appProductionSources();
    for (const retiredSeam of [
      "daemonPolicy: DaemonPolicy =",
      "readonly policy?: DaemonPolicy",
      "readonly policy: DaemonPolicy =",
      "COMMAND_OUTPUT_CHUNK_BYTES",
      "COMMAND_OUTPUT_LIMIT_BYTES",
      "COMPLETION_SPOOL_INLINE_BYTES",
      "DAEMON_COMPLETION_SPOOL_LIMIT_BYTES",
      "DAEMON_MAXIMUM_CONTROL_FRAME_BYTES",
      "DAEMON_IDLE_TIMEOUT_MS",
      "DAEMON_LOG_BACKUP_COUNT",
      "DAEMON_LOG_ROTATE_BYTES",
      "DAEMON_RESOURCE_RESTART_LIMIT",
      "DAEMON_RESOURCE_RESTART_WINDOW_MS",
      "DAEMON_RESOURCE_SAMPLE_INTERVAL_MS",
      "DAEMON_STARTUP_TIMEOUT_MS",
      "DAEMON_TERMINATION_TIMEOUT_MS",
      "DEFAULT_EXECUTION_REQUEST_TIMEOUT_MS",
      "DEFAULT_MAXIMUM_FRAME_BYTES",
      "DEFAULT_REQUEST_TIMEOUT_MS",
      "completionSpoolLimits",
      "executionRequestTimeoutMs?:",
      "maximumAggregateBytes?:",
      "maximumFrameBytes?:",
      "maximumResultBytes?:",
      "maximumRetainedOperationTraces",
      "operationTraceRetentionMs",
      "outputInlineBytes",
      "requestTimeoutMs?:",
      "resourceCheckIntervalMs",
      "resourcePolicy?:",
      "startupHeartbeatIntervalMs",
      "stopTimeoutMs?:",
      "terminationTimeoutMs?:",
      "DaemonResourcePolicy",
    ]) {
      expect(sources).not.toContain(retiredSeam);
    }
  });
});
