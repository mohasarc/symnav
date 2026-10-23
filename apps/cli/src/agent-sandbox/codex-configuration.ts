import { join } from "node:path";
import { TomlDocument } from "./toml-document.js";
import {
  AgentSandboxConfiguration,
  type AgentConfigurationLocations,
  type AgentSetupResult,
} from "./agent-configuration.js";
import { AgentConfigurationFile } from "./agent-configuration-file.js";
import { AgentExecutable } from "./agent-executable.js";

export class CodexSandboxConfiguration extends AgentSandboxConfiguration {
  public readonly agent = "codex";
  public readonly configurationPath: string;

  public constructor(locations: AgentConfigurationLocations) {
    super();
    this.configurationPath = join(
      locations.codexHome ?? join(locations.homeDirectory, ".codex"),
      "config.toml",
    );
  }

  public async grant(stateDirectory: string): Promise<AgentSetupResult> {
    const file = new AgentConfigurationFile(this.configurationPath);
    const original = await file.read();
    const document = new TomlDocument(original);
    const path = ["sandbox_workspace_write", "writable_roots"];
    const roots = document.value(path) as string[] | undefined;
    const granted = roots?.includes(stateDirectory) ?? false;
    if (!granted) {
      const updated =
        roots === undefined
          ? original.length === 0
            ? document.appendTable(
                ["sandbox_workspace_write"],
                `writable_roots = [${JSON.stringify(stateDirectory)}]`,
              )
            : document.set(path, `[${JSON.stringify(stateDirectory)}]`)
          : document.appendString(path, stateDirectory);
      new TomlDocument(updated);
      await file.publish(original, updated);
    }
    return {
      agent: this.agent,
      stateDirectory,
      configurationPath: this.configurationPath,
      changed: !granted,
      installed: await AgentExecutable.installed("codex"),
    };
  }
}
