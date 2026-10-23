import { ParseError } from "toml-eslint-parser";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

  private readonly homeDirectory: string;

  public constructor(locations: AgentConfigurationLocations) {
    super();
    this.homeDirectory = locations.homeDirectory;
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
    const updated =
      document.configuration.default_permissions !== undefined
        ? this.grantProfile(document, stateDirectory)
        : this.grantLegacy(document, stateDirectory, original);
    const changed = updated !== original;
    if (changed) {
      new TomlDocument(updated);
      await file.publish(original, updated);
    }
    return {
      agent: this.agent,
      stateDirectory,
      configurationPath: this.configurationPath,
      changed,
      installed: await AgentExecutable.installed("codex"),
    };
  }
  private grantLegacy(document: TomlDocument, stateDirectory: string, original: string): string {
    const path = ["sandbox_workspace_write", "writable_roots"];
    const roots = document.value(path) as string[] | undefined;
    if (
      document.configuration.sandbox_mode === "danger-full-access" ||
      roots?.some((root) => this.covers(root, stateDirectory))
    )
      return original;
    if (roots !== undefined) return document.appendString(path, stateDirectory);
    return original.length === 0
      ? document.appendTable(
          ["sandbox_workspace_write"],
          `writable_roots = [${JSON.stringify(stateDirectory)}]`,
        )
      : document.set(path, `[${JSON.stringify(stateDirectory)}]`);
  }

  private grantProfile(document: TomlDocument, stateDirectory: string): string {
    const selected = document.configuration.default_permissions as string;
    if (selected === ":danger-full-access") return document.source;
    if (selected === ":workspace" || selected === ":read-only") {
      let name = "symnav";
      for (let suffix = 2; document.value(["permissions", name]) !== undefined; suffix += 1)
        name = `symnav-${suffix}`;
      const selection = document.set(["default_permissions"], JSON.stringify(name));
      const parent = new TomlDocument(selection).set(
        ["permissions", name, "extends"],
        JSON.stringify(selected),
      );
      return new TomlDocument(parent).set(
        ["permissions", name, "filesystem", stateDirectory],
        '"write"',
      );
    }
    if (this.profileGrants(document, selected, stateDirectory, new Set())) return document.source;
    const path = ["permissions", selected, "filesystem", stateDirectory];
    if (document.value(path) === "write") return document.source;
    return document.set(path, '"write"');
  }

  private profileGrants(
    document: TomlDocument,
    name: string,
    stateDirectory: string,
    ancestors: Set<string>,
  ): boolean {
    if (ancestors.has(name)) throw new Error("permission profile inheritance cycle");
    if (name === ":workspace" || name === ":read-only") return false;
    ancestors.add(name);
    const profile = document.value(["permissions", name]) as Record<string, unknown> | undefined;
    if (profile === undefined) return false;
    const filesystem = profile.filesystem as Record<string, unknown> | undefined;
    if (filesystem !== undefined) {
      let mostSpecific = -1;
      let granted = false;
      for (const [path, access] of Object.entries(filesystem)) {
        const entries =
          typeof access === "object" && access !== null ? Object.entries(access) : [[".", access]];
        for (const [subpath, permission] of entries) {
          const rulePath = subpath === "." ? path : join(path, subpath as string);
          if (!this.covers(rulePath, stateDirectory)) continue;
          const specificity = this.absolutePath(rulePath)?.length ?? -1;
          if (specificity < mostSpecific) continue;
          mostSpecific = specificity;
          granted = permission === "write";
        }
      }
      if (mostSpecific >= 0) return granted;
    }
    return (
      typeof profile.extends === "string" &&
      this.profileGrants(document, profile.extends, stateDirectory, ancestors)
    );
  }

  private covers(configuredPath: string, stateDirectory: string): boolean {
    const absolute = this.absolutePath(configuredPath);
    if (absolute === undefined) return false;
    const descendant = relative(absolute, stateDirectory);
    return (
      descendant === "" ||
      (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${sep}`))
    );
  }

  private absolutePath(path: string): string | undefined {
    if (path === ":root") return resolve(sep);
    if (path === "~" || path.startsWith("~/") || path.startsWith("~\\"))
      return resolve(this.homeDirectory, path.slice(2));
    return isAbsolute(path) ? resolve(path) : undefined;
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
