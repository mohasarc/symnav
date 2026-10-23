import { ParseError } from "toml-eslint-parser";
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
    try {
      return await this.grantConfiguration(stateDirectory);
    } catch (error) {
      const reason =
        error instanceof ParseError
          ? `invalid TOML at line ${error.lineNumber}`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`cannot update ${this.configurationPath}: ${reason}`, { cause: error });
    }
  }

  private async grantConfiguration(stateDirectory: string): Promise<AgentSetupResult> {
    const file = new AgentConfigurationFile(this.configurationPath);
    const original = await file.read();
    const document = new TomlDocument(original);
    this.validateLegacy(document);
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
  private validateLegacy(document: TomlDocument): void {
    const configuration = document.configuration;
    if (
      (configuration.default_permissions !== undefined ||
        configuration.permissions !== undefined) &&
      (configuration.sandbox_mode !== undefined ||
        configuration.sandbox_workspace_write !== undefined)
    ) {
      throw new Error("legacy sandbox settings conflict with permission profiles");
    }
    if (
      configuration.sandbox_mode !== undefined &&
      !["workspace-write", "read-only", "danger-full-access"].includes(
        String(configuration.sandbox_mode),
      )
    ) {
      throw new Error("sandbox_mode must be a supported sandbox mode");
    }
    const sandbox = configuration.sandbox_workspace_write;
    if (
      sandbox !== undefined &&
      (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox))
    ) {
      throw new Error("sandbox_workspace_write must be a table");
    }
    const roots = document.value(["sandbox_workspace_write", "writable_roots"]);
    if (
      roots !== undefined &&
      (!Array.isArray(roots) || !roots.every((root) => typeof root === "string"))
    ) {
      throw new Error("writable_roots must be an array of strings");
    }
  }
}
