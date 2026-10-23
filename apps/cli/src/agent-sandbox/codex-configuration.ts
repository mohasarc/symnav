import { join } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
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
    const configuration = getStaticTOMLValue(parseTOML(original)) as {
      sandbox_workspace_write?: { writable_roots?: string[] };
    };
    const granted =
      configuration.sandbox_workspace_write?.writable_roots?.includes(stateDirectory) ?? false;
    if (!granted) {
      const updated = `${original}[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(stateDirectory)}]\n`;
      parseTOML(updated);
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
