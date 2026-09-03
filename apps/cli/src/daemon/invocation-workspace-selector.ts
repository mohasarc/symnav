import { Command as CommanderCommand } from "commander";
import { resolve } from "node:path";
import type { DaemonCommandName } from "@symnav/daemon";
import type { InvocationRoute, SelectedInvocation } from "./invocation-route.js";

type WorkspaceCommandName = Exclude<DaemonCommandName, "help" | "version" | "unknown">;

const workspaceCommandNames = {
  overview: "overview",
  resolve: "resolve",
  def: "def",
  refs: "refs",
  context: "context",
  graph: "graph",
  stats: "stats",
} as const satisfies Readonly<Record<WorkspaceCommandName, WorkspaceCommandName>>;

export class InvocationWorkspaceSelector {
  classify(argv: readonly string[], cwd: string): InvocationRoute {
    return this.select(argv, cwd).route;
  }

  select(argv: readonly string[], cwd: string): SelectedInvocation {
    const parsed = new CommanderCommand()
      .helpOption(false)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .option("--cwd <dir>")
      .option("-h, --help")
      .option("-v, --version")
      .argument("[command]")
      .argument("[arguments...]")
      .parse([...argv], { from: "user" });
    const [command, action] = parsed.args;
    const options = parsed.opts<{
      cwd?: string;
      help?: boolean;
      version?: boolean;
    }>();

    if (options.help === true) {
      return { route: { kind: "local" }, commandName: "help", argv };
    }
    if (options.version === true) {
      return { route: { kind: "local" }, commandName: "version", argv };
    }
    if (command === "daemon" && (action === "start" || action === "status" || action === "stop")) {
      return { route: { kind: "daemon-control", action }, commandName: "unknown", argv };
    }
    const commandName = InvocationWorkspaceSelector.workspaceCommandName(command);
    if (commandName === undefined) {
      return { route: { kind: "local" }, commandName: "unknown", argv };
    }
    const cwdOverride = options.cwd;
    const startDir = cwdOverride === undefined ? cwd : resolve(cwd, cwdOverride);
    return {
      route: { kind: "workspace", startDir },
      commandName,
      argv:
        cwdOverride === undefined
          ? argv
          : InvocationWorkspaceSelector.rewriteEffectiveCwd(argv, startDir),
    };
  }

  private static workspaceCommandName(command: string | undefined): WorkspaceCommandName | undefined {
    if (command === undefined || !Object.hasOwn(workspaceCommandNames, command)) return undefined;
    return workspaceCommandNames[command as WorkspaceCommandName];
  }

  private static rewriteEffectiveCwd(argv: readonly string[], startDir: string): readonly string[] {
    const separatorIndex = argv.indexOf("--");
    const optionsEnd = separatorIndex === -1 ? argv.length : separatorIndex;
    let optionIndex: number | undefined;
    let valueIndex: number | undefined;
    for (let index = 0; index < optionsEnd; index += 1) {
      const argument = argv[index];
      if (argument === "--cwd" && index + 1 < optionsEnd) {
        optionIndex = index;
        valueIndex = index + 1;
        index += 1;
      } else if (argument?.startsWith("--cwd=")) {
        optionIndex = index;
        valueIndex = undefined;
      }
    }
    if (optionIndex === undefined) return argv;
    return argv.map((argument, index) => {
      if (index === valueIndex) return startDir;
      if (index === optionIndex && valueIndex === undefined) return `--cwd=${startDir}`;
      return argument;
    });
  }
}
