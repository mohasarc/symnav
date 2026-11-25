import type { DaemonBenchmarkScale } from "./daemon-workspace-generator.js";
import type { DaemonWorkspaceLanguage } from "./daemon-workspace-profile.js";

export interface DaemonBenchmarkRunEnvironment {
  readonly SYMNAV_BENCHMARK_ARTIFACT_DIR?: string;
  readonly SYMNAV_BENCHMARK_MIN_MEMORY_BYTES?: string;
}

export class DaemonBenchmarkRunConfiguration {
  private static readonly usage =
    "Usage: pnpm daemon:benchmark --scale <1|2|3|10> [--profile <typescript|javascript>]";

  private static readonly profileFileNames: Readonly<Record<DaemonWorkspaceLanguage, string>> = {
    typescript: "daemon-workspace-1x.v1.json",
    javascript: "daemon-workspace-js-1x.v1.json",
  };

  private constructor(
    readonly scale: DaemonBenchmarkScale,
    readonly profile: DaemonWorkspaceLanguage,
    readonly artifactDirectory: string,
    readonly minimumMemoryBytes: number,
    readonly effectiveMemoryBytes: number,
  ) {}

  static parse(
    argv: readonly string[],
    environment: DaemonBenchmarkRunEnvironment,
    systemMemoryBytes: number,
    constrainedMemoryBytes?: number,
  ): DaemonBenchmarkRunConfiguration {
    const options = this.options(argv);
    const scale = this.scale(options.get("--scale"));
    const profile = this.profile(options.get("--profile"));
    const minimumMemoryBytes = this.minimumMemory(environment, scale);
    const effectiveMemoryBytes =
      constrainedMemoryBytes === undefined || constrainedMemoryBytes <= 0
        ? systemMemoryBytes
        : Math.min(systemMemoryBytes, constrainedMemoryBytes);
    if (effectiveMemoryBytes < minimumMemoryBytes) {
      throw new Error("Daemon benchmark runner memory is undersized");
    }
    const artifactDirectory = environment.SYMNAV_BENCHMARK_ARTIFACT_DIR ?? "artifacts";
    if (artifactDirectory.length === 0) throw new Error(this.usage);
    return new DaemonBenchmarkRunConfiguration(
      scale,
      profile,
      artifactDirectory,
      minimumMemoryBytes,
      effectiveMemoryBytes,
    );
  }

  get profileFileName(): string {
    return DaemonBenchmarkRunConfiguration.profileFileNames[this.profile];
  }

  artifactFileName(platform: NodeJS.Platform): string {
    const profilePart = this.profile === "typescript" ? "" : `${this.profile}-`;
    return `daemon-benchmark-${profilePart}${this.scale}x-${platform}.json`;
  }

  private static options(argv: readonly string[]): ReadonlyMap<string, string> {
    const options = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index]!;
      const value = argv[index + 1];
      const isKnownOption = name === "--scale" || name === "--profile";
      if (!isKnownOption || value === undefined || options.has(name)) {
        throw new Error(this.usage);
      }
      options.set(name, value);
    }
    return options;
  }

  private static profile(value: string | undefined): DaemonWorkspaceLanguage {
    if (value === undefined) return "typescript";
    if (value !== "typescript" && value !== "javascript") throw new Error(this.usage);
    return value;
  }

  private static scale(value: string | undefined): DaemonBenchmarkScale {
    const parsed = Number(value);
    if (parsed !== 1 && parsed !== 2 && parsed !== 3 && parsed !== 10) {
      throw new Error(this.usage);
    }
    return parsed;
  }

  private static minimumMemory(
    environment: DaemonBenchmarkRunEnvironment,
    scale: DaemonBenchmarkScale,
  ): number {
    const declaredMinimum = scale === 10 ? 32 * 1024 ** 3 : 8 * 1024 ** 3;
    const configured = environment.SYMNAV_BENCHMARK_MIN_MEMORY_BYTES;
    if (configured === undefined) return declaredMinimum;
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(this.usage);
    return Math.max(declaredMinimum, parsed);
  }
}
