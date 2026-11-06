import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSandboxConfiguration, SupportedAgent } from "./agent-configuration.js";
import type { AgentDoctorResult } from "./agent-doctor-result.js";
import { AgentExecutable } from "./agent-executable.js";
import type { AgentProbePolicy } from "./agent-probe-policy.js";
import { SandboxProbeCleanupError } from "./sandbox-probe-cleanup-error.js";
import { SandboxProbeStartupError } from "./sandbox-probe-startup-error.js";
import type { AgentSandboxRuntime } from "./agent-sandbox-runtime.js";

interface AgentSandboxDoctorOptions {
  readonly stateDirectory: string;
  readonly configurations: readonly AgentSandboxConfiguration[];
  readonly runtimes: readonly AgentSandboxRuntime[];
}

type PreparedDoctorCheck =
  | { readonly result: AgentDoctorResult }
  | {
      readonly agent: SupportedAgent;
      readonly scratch: string;
      readonly workspace: string;
      readonly policy: AgentProbePolicy;
      readonly runtime: AgentSandboxRuntime;
    };

export class AgentSandboxDoctor {
  public constructor(private readonly options: AgentSandboxDoctorOptions) {}

  public async check(
    agent?: SupportedAgent,
    signal?: AbortSignal,
  ): Promise<readonly AgentDoctorResult[]> {
    const agents: readonly SupportedAgent[] =
      agent === undefined ? ["codex", "claude-code"] : [agent];
    const prepared: PreparedDoctorCheck[] = [];
    for (const selected of agents) prepared.push(await this.prepare(selected));
    await this.verifyState();
    const results: AgentDoctorResult[] = [];
    for (const check of prepared)
      results.push("result" in check ? check.result : await this.checkAgent(check, signal));
    return results;
  }

  private async prepare(agent: SupportedAgent): Promise<PreparedDoctorCheck> {
    if (!(await AgentExecutable.installed(agent === "codex" ? "codex" : "claude")))
      return { result: { agent, status: "skip", reason: "not installed" } };
    const configuration = this.options.configurations.find(
      (configuration) => configuration.agent === agent,
    )!;
    const scratch = join(this.options.stateDirectory, "doctor", randomUUID());
    const workspace = join(scratch, "workspace");
    try {
      const policy = await configuration.inspect(this.options.stateDirectory, workspace);
      if (!policy.grantsState)
        return {
          result: {
            agent,
            status: "fail",
            reason: `sandbox denies write to ${this.options.stateDirectory}; run 'symnav setup ${agent}'`,
          },
        };
      return {
        agent,
        scratch,
        workspace,
        policy,
        runtime: this.options.runtimes.find((runtime) => runtime.agent === agent)!,
      };
    } catch (error) {
      return { result: this.failure(agent, error) };
    }
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
    check: Exclude<PreparedDoctorCheck, { readonly result: AgentDoctorResult }>,
    signal?: AbortSignal,
  ): Promise<AgentDoctorResult> {
    const { agent, scratch, workspace, policy, runtime } = check;
    let created = false;
    try {
      signal?.throwIfAborted();
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
      if (error instanceof SandboxProbeCleanupError) created = false;
      return this.failure(agent, error);
    } finally {
      if (created) await this.removeScratch(scratch);
    }
  }

  private failure(agent: SupportedAgent, error: unknown): AgentDoctorResult {
    if (error instanceof SandboxProbeStartupError)
      return {
        agent,
        status: "fail",
        reason: `${error.message.replace(/\s+/gu, " ").trim()}; investigate the reported startup failure and rerun doctor`,
      };
    const reason = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 360);
    return {
      agent,
      status: "fail",
      reason: `${reason}; check sandbox policy and restart the agent session`,
    };
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
