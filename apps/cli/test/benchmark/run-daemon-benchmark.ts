import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join, resolve } from "node:path";
import { DaemonBenchmarkRunConfiguration } from "./daemon-benchmark-run-configuration.js";
import { DaemonScaleBenchmarkHarness } from "./daemon-scale-benchmark-harness.js";
import { DaemonWorkspaceProfileValidator } from "./daemon-workspace-profile.js";

class DaemonBenchmarkRunner {
  static async run(): Promise<void> {
    const configuration = DaemonBenchmarkRunConfiguration.parse(
      process.argv.slice(2),
      process.env,
      totalmem(),
      process.constrainedMemory?.(),
    );
    const reviewed = JSON.parse(
      readFileSync(new URL("./profiles/daemon-workspace-1x.v1.json", import.meta.url), "utf8"),
    );
    const profile = DaemonWorkspaceProfileValidator.parse(reviewed);
    const artifact = await new DaemonScaleBenchmarkHarness({
      profile,
      scale: configuration.scale,
      generatorVersion: "1.0.0",
      seed: "daemon-workspace-v1",
    }).run();
    const artifactDirectory = resolve(
      process.env.INIT_CWD ?? process.cwd(),
      configuration.artifactDirectory,
    );
    mkdirSync(artifactDirectory, { recursive: true });
    const artifactPath = join(
      artifactDirectory,
      `daemon-benchmark-${configuration.scale}x-${process.platform}.json`,
    );
    writeFileSync(artifactPath, `${JSON.stringify(artifact, undefined, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: artifact.schemaVersion,
        scale: artifact.scale,
        passed: artifact.failures.length === 0,
        failures: artifact.failures,
        parity: artifact.parity,
        freshness: artifact.freshness,
        statusResponsive: artifact.statusResponsive,
        continuity: artifact.continuity,
        exactlyOnceTelemetry: artifact.exactlyOnceTelemetry,
        resourcesWithinPolicy: artifact.resourcesWithinPolicy,
        spoolsCleaned: artifact.spoolsCleaned,
      })}\n`,
    );
    if (artifact.failures.length > 0) {
      throw new Error(`Daemon benchmark gate failed: ${artifact.failures.join(",")}`);
    }
  }
}

await DaemonBenchmarkRunner.run();
