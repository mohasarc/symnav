import { Command as CommanderCommand } from "commander";
import type { InvocationRoute, SelectedInvocation } from "./invocation-route.js";

const workspaceCommands = new Set([
  "overview",
  "resolve",
  "def",
  "refs",
  "context",
  "graph",
  "stats",
]);

export class InvocationWorkspaceSelector {
  classify(argv: readonly string[], cwd: string): InvocationRoute {
    return this.select(argv, cwd).route;
  }

  select(argv: readonly string[], _cwd: string): SelectedInvocation {
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
    const options = parsed.opts<{ help?: boolean; version?: boolean }>();

    if (options.help === true || options.version === true) {
      return { route: { kind: "local" }, argv };
    }
    if (command === "daemon" && (action === "start" || action === "status" || action === "stop")) {
      return { route: { kind: "daemon-control", action }, argv };
    }
    if (command !== undefined && workspaceCommands.has(command)) {
      return { route: { kind: "workspace", startDir: _cwd }, argv };
    }
    return { route: { kind: "local" }, argv };
  }
}
