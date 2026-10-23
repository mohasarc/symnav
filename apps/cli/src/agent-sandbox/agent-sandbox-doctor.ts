import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSandboxConfiguration, SupportedAgent } from "./agent-configuration.js";
import type { AgentDoctorResult } from "./agent-doctor-result.js";
import { AgentExecutable } from "./agent-executable.js";
import type { AgentSandboxRuntime } from "./agent-sandbox-runtime.js";

interface AgentSandboxDoctorOptions {
  readonly stateDirectory: string;
  readonly configurations: readonly AgentSandboxConfiguration[];
  readonly runtimes: readonly AgentSandboxRuntime[];
}

export class AgentSandboxDoctor {
  public constructor(private readonly options: AgentSandboxDoctorOptions) {}

  public async check(
    agent?: SupportedAgent,
    signal?: AbortSignal,
  ): Promise<readonly AgentDoctorResult[]> {
    await this.verifyState();
    const agents: readonly SupportedAgent[] =
      agent === undefined ? ["codex", "claude-code"] : [agent];
    const results: AgentDoctorResult[] = [];
    for (const selected of agents) results.push(await this.checkAgent(selected, signal));
    return results;
  }

  private async verifyState(): Promise<void> {
    const scratch = join(this.options.stateDirectory, "doctor", randomUUID());
    let created = false;
    try {
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      created = true;
      await writeFile(join(scratch, "write-check"), "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw new Error(
        `cannot write ${this.options.stateDirectory} (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
        { cause: error },
      );
    } finally {
      if (created) await this.removeScratch(scratch);
    }
  }

  private async checkAgent(
    agent: SupportedAgent,
    signal?: AbortSignal,
  ): Promise<AgentDoctorResult> {
    if (!(await AgentExecutable.installed(agent === "codex" ? "codex" : "claude")))
      return { agent, status: "skip", reason: "not installed" };
    const configuration = this.options.configurations.find(
      (configuration) => configuration.agent === agent,
    )!;
    const runtime = this.options.runtimes.find((runtime) => runtime.agent === agent)!;
    const scratch = join(this.options.stateDirectory, "doctor", randomUUID());
    const workspace = join(scratch, "workspace");
    let created = false;
    try {
      signal?.throwIfAborted();
      const policy = await configuration.inspect(this.options.stateDirectory, workspace);
      if (!policy.grantsState)
        return {
          agent,
          status: "fail",
          reason: `sandbox denies write to ${this.options.stateDirectory}; run 'symnav setup ${agent}'`,
        };
      if (policy.disabledReason !== undefined)
        return { agent, status: "fail", reason: policy.disabledReason };
      const availability = await runtime.availability();
      if (availability !== "available")
        return {
          agent,
          status: "ok",
          check: "configuration",
          skippedReason:
            availability === "not-found"
              ? "sandbox runtime not found"
              : "sandbox runtime cannot be run from the command line",
        };
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      created = true;
      await mkdir(join(workspace, ".git"));
      await writeFile(
        join(workspace, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022" }, include: ["index.ts"] }),
      );
      await writeFile(join(workspace, "index.ts"), "export const doctorProbe = 1;\n");
      await runtime.probe({
        scratchDirectory: scratch,
        workspace,
        stateDirectory: join(scratch, "probe-state"),
        policy,
        ...(signal === undefined ? {} : { signal }),
      });
      return { agent, status: "ok", check: "live" };
    } catch (error) {
      return {
        agent,
        status: "fail",
        reason: `${error instanceof Error ? error.message : String(error)}; check sandbox policy and restart the agent session`,
      };
    } finally {
      if (created) await this.removeScratch(scratch);
    }
  }

  private async removeScratch(scratch: string): Promise<void> {
    await rm(scratch, { recursive: true, force: true });
    await rmdir(join(this.options.stateDirectory, "doctor")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT" && error.code !== "EEXIST")
          throw error;
      },
    );
  }
}
