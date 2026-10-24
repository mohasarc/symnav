import { fileURLToPath } from "node:url";
import { DaemonPolicy } from "@symnav/daemon";
import { AgentSandboxRuntime, type SandboxProbeRequest } from "./agent-sandbox-runtime.js";
import type { SandboxLaunchCommand } from "./sandbox-launch-command.js";
import { SandboxProcessSession } from "./sandbox-process-session.js";
import { SandboxProbeProof } from "./sandbox-probe-proof.js";

export abstract class CommandAgentSandboxRuntime extends AgentSandboxRuntime {
  protected abstract command(request: SandboxProbeRequest): Promise<SandboxLaunchCommand>;

  public async probe(request: SandboxProbeRequest): Promise<void> {
    const command = await this.command(request);
    const { createDefaultDependencies } = await import("../program.js");
    const client = createDefaultDependencies(
      request.stateDirectory,
      DaemonPolicy.currentSystem(),
      true,
    ).daemonClient;
    const session = new SandboxProcessSession(command);
    await new SandboxProbeProof({
      session,
      workspace: request.workspace,
      stateDirectory: request.stateDirectory,
      cleanup: async () => {
        await client.control({ action: "stop", workspaceRoot: request.workspace });
        const status = await client.control({ action: "status" });
        if (status.daemons.some((daemon) => daemon.workspaceRoot === request.workspace))
          throw new Error("scratch daemon has not exited");
      },
    }).run(request.signal);
  }

  protected environment(request: SandboxProbeRequest): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      SYMNAV_DAEMON: "1",
      SYMNAV_TELEMETRY: "1",
      SYMNAV_STATE_DIR: request.stateDirectory,
    };
    for (const name of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SYSTEMROOT",
      "WINDIR",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "TMP",
      "TEMP",
    ])
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    return environment;
  }

  protected entry(): string {
    return fileURLToPath(new URL("./sandbox-probe-entry.js", import.meta.url));
  }
}
