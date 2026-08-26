import type { DaemonBenchmarkScale } from "./daemon-workspace-generator.js";

export interface DaemonBenchmarkRunEnvironment {
  readonly SYMNAV_BENCHMARK_ARTIFACT_DIR?: string;
  readonly SYMNAV_BENCHMARK_MIN_MEMORY_BYTES?: string;
}

export class DaemonBenchmarkRunConfiguration {
  private static readonly usage = "Usage: pnpm daemon:benchmark --scale <1|2|3|10>";

  private constructor(
    readonly scale: DaemonBenchmarkScale,
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
    if (argv.length !== 2 || argv[0] !== "--scale") throw new Error(this.usage);
    const scale = this.scale(argv[1]);
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
      artifactDirectory,
      minimumMemoryBytes,
      effectiveMemoryBytes,
    );
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
    const configured = environment.SYMNAV_BENCHMARK_MIN_MEMORY_BYTES;
    if (configured === undefined) return scale === 10 ? 32 * 1024 ** 3 : 8 * 1024 ** 3;
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(this.usage);
    return parsed;
  }
}
