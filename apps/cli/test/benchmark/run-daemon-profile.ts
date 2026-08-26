import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DaemonWorkspaceProfiler } from "./daemon-workspace-profile.js";

class DaemonProfileRunner {
  static async run(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--workspace" || argv[1]!.length === 0) {
      throw new Error("Usage: pnpm daemon:profile --workspace <local-path>");
    }
    const workspaceRoot = realpathSync(resolve(process.env.INIT_CWD ?? process.cwd(), argv[1]!));
    const profile = await new DaemonWorkspaceProfiler().profile(workspaceRoot);
    process.stdout.write(`${JSON.stringify(profile, undefined, 2)}\n`);
  }
}

await DaemonProfileRunner.run();
