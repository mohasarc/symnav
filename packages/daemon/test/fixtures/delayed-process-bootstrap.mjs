import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

class DelayedProcessBootstrap {
  static async wait() {
    if (!isMainThread) return;
    const stateDirectory = process.env.SYMNAV_STATE_DIR;
    writeFileSync(join(stateDirectory, "bootstrap-waiting"), "waiting");
    while (!existsSync(join(stateDirectory, "bootstrap-release")))
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

await DelayedProcessBootstrap.wait();
