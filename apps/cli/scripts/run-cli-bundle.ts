import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliBundle } from "./cli-bundle.js";

class CliBundleRunner {
  static async run(): Promise<void> {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const outDirectory = join(packageRoot, "dist");
    rmSync(outDirectory, { recursive: true, force: true });
    await new CliBundle({ outDirectory, packageRoot }).build();
  }
}

await CliBundleRunner.run();
