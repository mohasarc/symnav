import { applyEdits, findNodeAtLocation, modify, parseTree, type ParseError } from "jsonc-parser";
import { join } from "node:path";
import {
  AgentSandboxConfiguration,
  type AgentConfigurationLocations,
  type AgentSetupResult,
} from "./agent-configuration.js";
import { AgentConfigurationFile } from "./agent-configuration-file.js";
import { AgentExecutable } from "./agent-executable.js";

export class ClaudeCodeSandboxConfiguration extends AgentSandboxConfiguration {
  public readonly agent = "claude-code";
  public readonly configurationPath: string;

  public constructor(locations: AgentConfigurationLocations) {
    super();
    this.configurationPath = join(locations.homeDirectory, ".claude", "settings.json");
  }

  public async grant(stateDirectory: string): Promise<AgentSetupResult> {
    try {
      const file = new AgentConfigurationFile(this.configurationPath);
      const original = await file.read();
      const updated = this.addGrant(original, stateDirectory);
      const changed = updated !== original;
      if (changed) await file.publish(original, updated);
      return {
        agent: this.agent,
        stateDirectory,
        configurationPath: this.configurationPath,
        changed,
        installed: await AgentExecutable.installed("claude"),
      };
    } catch (error) {
      throw new Error(
        `cannot update ${this.configurationPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  private addGrant(original: string, stateDirectory: string): string {
    if (original.length === 0)
      return `${JSON.stringify({ sandbox: { filesystem: { allowWrite: [stateDirectory] } } }, null, 2)}\n`;
    const errors: ParseError[] = [];
    const root = parseTree(original, errors, { disallowComments: true, allowTrailingComma: false });
    if (root === undefined || errors.length > 0) throw new Error("invalid JSON");
    const path = ["sandbox", "filesystem", "allowWrite"];
    const grants = findNodeAtLocation(root, path)?.children ?? [];
    if (grants.some((grant) => grant.value === stateDirectory)) return original;
    const updated = applyEdits(original, modify(original, [...path, -1], stateDirectory, {}));
    return updated;
  }
}
