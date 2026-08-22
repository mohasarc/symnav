import { DaemonBenchmarkHarness } from "./daemon-benchmark-harness.js";

const measurement = await new DaemonBenchmarkHarness(2_000).run();
process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
