import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProbeRequest } from "./agent-sandbox-runtime.js";
import { AgentExecutable } from "./agent-executable.js";
import { CommandAgentSandboxRuntime } from "./command-agent-sandbox-runtime.js";
import type { SandboxLaunchCommand } from "./sandbox-launch-command.js";

export class CodexSandboxRuntime extends CommandAgentSandboxRuntime {
  public readonly agent = "codex";
  public async availability(): Promise<"available" | "not-found" | "not-exposable"> {
    if (process.platform !== "darwin" && process.platform !== "linux") return "not-exposable";
    return (await AgentExecutable.find("codex")) === undefined ? "not-found" : "available";
  }
  protected async command(request: SandboxProbeRequest): Promise<SandboxLaunchCommand> {
    const executable = await AgentExecutable.find("codex");
    if (executable === undefined) throw new Error("Codex sandbox runtime disappeared from PATH");
    const codexHome = join(request.scratchDirectory, "codex");
    await mkdir(codexHome);
    await writeFile(join(codexHome, "config.toml"), request.policy.configuration, {
      flag: "wx",
      mode: 0o600,
    });
    const environment: NodeJS.ProcessEnv = { ...this.environment(request), CODEX_HOME: codexHome };
    const prefix = ["sandbox"];
    let help = await this.help(executable, prefix, environment);
    if (
      /\bmacos\b/u.test(help) &&
      /\blinux\b/u.test(help) &&
      !help.includes("--permission-profile") &&
      !help.includes("--permissions-profile")
    ) {
      prefix.push(process.platform === "darwin" ? "macos" : "linux");
      help = await this.help(executable, prefix, environment);
    }
    const profileFlag = help.includes("--permission-profile")
      ? "--permission-profile"
      : help.includes("--permissions-profile")
        ? "--permissions-profile"
        : undefined;
    if (profileFlag === undefined)
      throw new Error("installed Codex sandbox interface cannot enforce this policy; update Codex");
    return {
      executable,
      argv: [
        ...prefix,
        profileFlag,
        "symnav-doctor",
        "-C",
        request.workspace,
        "--",
        process.execPath,
        this.entry(),
      ],
      cwd: request.workspace,
      environment,
    };
  }
  private help(
    executable: string,
    prefix: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<string> {
    return new Promise((resolve, reject) =>
      execFile(
        executable,
        [...prefix, "--help"],
        { env: environment, encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
        (error, stdout) => {
          if (error !== null)
            reject(
              new Error("installed Codex sandbox interface inspection failed", { cause: error }),
            );
          else resolve(stdout);
        },
      ),
    );
  }
}
