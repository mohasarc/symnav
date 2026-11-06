import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

  public static appProductionSources(): string {
    const sourceRoot = join(DaemonPackageMetadata.repoRoot, "apps/cli/src");
    return DaemonPackageMetadata.files(sourceRoot)
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
  }

  public static packageTestAppFileDependencies(): readonly string[] {
    const appPathPattern = /apps(?:[/\\]|["'`]\s*,\s*["'`])cli(?:[/\\]|["'`])/;
    return ["src", "test"].flatMap((directory) =>
      DaemonPackageMetadata.files(join(DaemonPackageMetadata.packageRoot, directory))
        .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
        .flatMap((path) =>
          appPathPattern.test(readFileSync(path, "utf8"))
            ? [relative(DaemonPackageMetadata.repoRoot, path)]
            : [],
        ),
    );
  }

  private static files(directory: string): readonly string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? DaemonPackageMetadata.files(path) : [path];
    });
  }
}

describe("@symnav/daemon package boundary", () => {
  it("has the exact private ESM root and executable entry exports", () => {
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
        "./process-entry": {
          types: "./dist/process-entry.d.ts",
          default: "./dist/process-entry.js",
        },
        "./worker-entry": {
          types: "./dist/worker-entry.d.ts",
          default: "./dist/worker-entry.js",
        },
        "./testing": {
          types: "./dist/testing/index.d.ts",
          default: "./dist/testing/index.js",
        },
      },
    });
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./process-entry",
      "./worker-entry",
      "./testing",
    ]);
  });

  it("has zero internal packages in every production dependency field", () => {
    const names = DaemonPackageMetadata.productionDependencyNames(DaemonPackageMetadata.manifest());
    expect(names.filter((name) => name.startsWith("@symnav/"))).toEqual([]);
  });

  it("keeps package test executors independent from app file layouts", () => {
    expect(DaemonPackageMetadata.packageTestAppFileDependencies()).toEqual([]);
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
      "startupTimeoutMs",
      "DaemonPolicyCodec",
      "DaemonResourcePolicy",
    ]) {
      expect(sources).not.toContain(retiredSeam);
    }
  });
});
