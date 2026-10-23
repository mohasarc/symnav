import { StateDirectoryResolver } from "../state-directory-resolver.js";
import { ParseError } from "toml-eslint-parser";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentProbePolicy } from "./agent-probe-policy.js";
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
  private readonly workspaceDirectory: string;

  public constructor(locations: AgentConfigurationLocations) {
    super();
    this.homeDirectory = locations.homeDirectory;
    this.workspaceDirectory = resolve(locations.workspaceDirectory ?? process.cwd());
    this.configurationPath = join(
      locations.codexHome ?? join(locations.homeDirectory, ".codex"),
      "config.toml",
    );
  }

  public async inspect(stateDirectory: string, workspace: string): Promise<AgentProbePolicy> {
    const document = new TomlDocument(
      await new AgentConfigurationFile(this.configurationPath).read(),
    );
    this.validateLegacy(document);
    const selected = document.configuration.default_permissions;
    if (selected !== undefined || document.configuration.permissions !== undefined)
      this.validateProfiles(document);
    const unrestricted =
      selected === ":danger-full-access" ||
      document.configuration.sandbox_mode === "danger-full-access";
    const legacyRoots = (document.value(["sandbox_workspace_write", "writable_roots"]) ??
      []) as string[];
    const effective = unrestricted
      ? { ":root": "write" }
      : typeof selected === "string"
        ? this.profileFilesystem(document, selected, new Set(), true)
        : this.legacyProbeFilesystem(document, legacyRoots);
    const filesystem = this.absoluteProbeFilesystem(
      effective,
      typeof selected === "string"
        ? this.probeWorkspaceRoots(document, selected)
        : [this.workspaceDirectory],
    );
    const rules: { path: string; access: unknown }[] = [];
    for (const [path, access] of Object.entries(filesystem)) {
      if (path === "glob_scan_max_depth") continue;
      for (const [subpath, permission] of this.isTable(access)
        ? Object.entries(access)
        : [[".", access]]) {
        const rulePath = subpath === "." ? path : join(path, subpath as string);
        const absolute = this.absolutePath(rulePath);
        rules.push({
          path: absolute === undefined ? rulePath : StateDirectoryResolver.canonicalize(absolute),
          access: permission,
        });
      }
    }
    const canonicalState = StateDirectoryResolver.canonicalize(stateDirectory);
    const covering = rules.filter((rule) => this.covers(rule.path, canonicalState));
    const specificity = Math.max(
      -1,
      ...covering.map((rule) => this.absolutePath(rule.path)!.length),
    );
    const nearest = covering.filter((rule) => this.absolutePath(rule.path)!.length === specificity);
    const grantsState =
      document.configuration.sandbox_mode !== "read-only" &&
      !nearest.some((rule) => rule.access === "deny") &&
      nearest.some((rule) => rule.access === "write");
    if (!Object.hasOwn(filesystem, workspace)) filesystem[workspace] = "read";
    const assignments = Object.entries(filesystem)
      .map(([path, access]) => `${JSON.stringify(path)} = ${this.serializeProbeValue(access)}`)
      .join("\n");
    return {
      grantsState,
      configuration: `default_permissions = "symnav-doctor"\n[permissions.symnav-doctor.filesystem]\n${assignments}\n[permissions.symnav-doctor.network]\nenabled = false\n`,
    };
  }

  private legacyProbeFilesystem(
    document: TomlDocument,
    roots: readonly string[],
  ): Record<string, unknown> {
    const filesystem: Record<string, unknown> =
      document.configuration.sandbox_mode === "workspace-write"
        ? this.builtinProbeFilesystem(":workspace")
        : { ":root": "read" };
    for (const [flag, path] of [
      ["exclude_tmpdir_env_var", ":tmpdir"],
      ["exclude_slash_tmp", ":slash_tmp"],
    ]) {
      const excluded = document.value(["sandbox_workspace_write", flag!]);
      if (excluded !== undefined && typeof excluded !== "boolean")
        throw new Error(`${flag} must be a boolean`);
      if (excluded) delete filesystem[path!];
    }
    for (const root of roots) filesystem[root] = "write";
    return filesystem;
  }

  private absoluteProbeFilesystem(
    filesystem: Record<string, unknown>,
    workspaceRoots: readonly string[],
  ): Record<string, unknown> {
    const expanded: Record<string, unknown> = {};
    for (const [path, access] of Object.entries(filesystem)) {
      const temporaryRoot = process.env.TMPDIR;
      if (path === ":tmpdir" && (temporaryRoot === undefined || !isAbsolute(temporaryRoot)))
        continue;
      const paths =
        path === ":workspace_roots"
          ? workspaceRoots
          : [path === ":tmpdir" ? temporaryRoot! : path === ":slash_tmp" ? resolve("/tmp") : path];
      for (const root of paths) {
        if (root === "glob_scan_max_depth") {
          expanded[root] = access;
          continue;
        }
        const absolute = this.absolutePath(root) ?? (root === ":minimal" ? root : undefined);
        if (absolute === undefined)
          throw new Error(`cannot translate Codex filesystem path ${root}`);
        expanded[absolute] = Object.hasOwn(expanded, absolute)
          ? this.mergeProbeAccess(expanded[absolute], access)
          : access;
      }
    }
    return expanded;
  }

  private mergeProbeAccess(left: unknown, right: unknown): unknown {
    const priority = ["read", "write", "deny"];
    if (!this.isTable(left) && !this.isTable(right))
      return priority[Math.max(priority.indexOf(String(left)), priority.indexOf(String(right)))];
    const merged: Record<string, unknown> = this.isTable(left) ? { ...left } : { ".": left };
    for (const [path, access] of Object.entries(this.isTable(right) ? right : { ".": right }))
      merged[path] = Object.hasOwn(merged, path)
        ? this.mergeProbeAccess(merged[path], access)
        : access;
    return merged;
  }

  private serializeProbeValue(value: unknown): string {
    if (this.isTable(value))
      return `{ ${Object.entries(value)
        .map(([key, access]) => `${JSON.stringify(key)} = ${JSON.stringify(access)}`)
        .join(", ")} }`;
    return JSON.stringify(value);
  }

  private probeWorkspaceRoots(document: TomlDocument, name: string): readonly string[] {
    if (name.startsWith(":")) return [this.workspaceDirectory];
    const profile = document.value(["permissions", name]) as Record<string, unknown>;
    const inherited =
      typeof profile.extends === "string"
        ? this.probeWorkspaceRoots(document, profile.extends)
        : [this.workspaceDirectory];
    const configured = profile.workspace_roots;
    if (configured === undefined) return inherited;
    if (
      !this.isTable(configured) ||
      Object.values(configured).some((value) => typeof value !== "boolean")
    )
      throw new Error("workspace_roots must map paths to booleans");
    const roots = new Set(inherited);
    for (const [path, enabled] of Object.entries(configured)) {
      const absolute = this.absolutePath(path);
      if (absolute === undefined) throw new Error(`cannot translate workspace root ${path}`);
      if (enabled) roots.add(absolute);
      else roots.delete(absolute);
    }
    return [...roots];
  }

  private builtinProbeFilesystem(name: string): Record<string, unknown> {
    if (name === ":read-only") return { ":root": "read" };
    return {
      ":root": "read",
      ":workspace_roots": {
        ".": "write",
        ".git": "read",
        ".agents": "read",
        ".codex": "read",
        ".aws": "read",
      },
      ":tmpdir": "write",
      ":slash_tmp": "write",
    };
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
    if (
      document.configuration.default_permissions !== undefined ||
      document.configuration.permissions !== undefined
    )
      this.validateProfiles(document);
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
    const rules = this.profileRules(document, selected, new Set());
    if (
      rules.some(
        (rule) =>
          rule.access === "deny" && this.absolutePath(rule.path) === resolve(stateDirectory),
      )
    ) {
      throw new Error("state directory has an explicit deny rule");
    }
    const path = ["permissions", selected, "filesystem", stateDirectory];
    if (this.isTable(this.profileFilesystem(document, selected, new Set())[stateDirectory]))
      path.push(".");
    if (document.value(path) === "write") return document.source;
    return document.set(path, '"write"');
  }

  private profileGrants(
    document: TomlDocument,
    name: string,
    stateDirectory: string,
    ancestors: Set<string>,
  ): boolean {
    const rules = this.profileRules(document, name, ancestors).filter((rule) =>
      this.covers(rule.path, stateDirectory),
    );
    const mostSpecific = Math.max(-1, ...rules.map((rule) => this.absolutePath(rule.path)!.length));
    const effective = rules.filter((rule) => this.absolutePath(rule.path)!.length === mostSpecific);
    return (
      !effective.some((rule) => rule.access === "deny") &&
      effective.some((rule) => rule.access === "write")
    );
  }

  private profileRules(
    document: TomlDocument,
    name: string,
    ancestors: Set<string>,
  ): { path: string; access: unknown }[] {
    const rules: { path: string; access: unknown }[] = [];
    for (const [path, access] of Object.entries(
      this.profileFilesystem(document, name, ancestors),
    )) {
      if (path === "glob_scan_max_depth") continue;
      const entries = this.isTable(access) ? Object.entries(access) : [[".", access]];
      for (const [subpath, permission] of entries) {
        rules.push({
          path: subpath === "." ? path : join(path, subpath as string),
          access: permission,
        });
      }
    }
    return rules;
  }

  private profileFilesystem(
    document: TomlDocument,
    name: string,
    ancestors: Set<string>,
    includeBuiltins = false,
  ): Record<string, unknown> {
    if (ancestors.has(name)) throw new Error("permission profile inheritance cycle");
    if (name === ":workspace" || name === ":read-only")
      return includeBuiltins ? this.builtinProbeFilesystem(name) : {};
    ancestors.add(name);
    const profile = document.value(["permissions", name]) as Record<string, unknown>;
    const inherited =
      typeof profile.extends === "string"
        ? this.profileFilesystem(document, profile.extends, ancestors, includeBuiltins)
        : {};
    const filesystem: Record<string, unknown> = { ...inherited };
    for (const [path, access] of Object.entries(
      (profile.filesystem ?? {}) as Record<string, unknown>,
    )) {
      const ancestor = inherited[path];
      filesystem[path] =
        this.isTable(ancestor) && this.isTable(access) ? { ...ancestor, ...access } : access;
    }
    return filesystem;
  }

  private validateProfiles(document: TomlDocument): void {
    const selected = document.configuration.default_permissions;
    if (typeof selected !== "string")
      throw new Error("default_permissions must select a permission profile");
    const profiles = document.configuration.permissions;
    if (profiles !== undefined && !this.isTable(profiles))
      throw new Error("permissions must be a table");
    this.validateProfile(document, selected, new Set());
  }

  private validateProfile(document: TomlDocument, name: string, ancestors: Set<string>): void {
    if ([":workspace", ":read-only", ":danger-full-access"].includes(name)) return;
    if (ancestors.has(name)) throw new Error("permission profile inheritance cycle");
    ancestors.add(name);
    const profile = document.value(["permissions", name]);
    if (profile === undefined) throw new Error(`unknown permission profile: ${name}`);
    if (!this.isTable(profile)) throw new Error(`permission profile ${name} must be a table`);
    if (profile.extends !== undefined) {
      if (typeof profile.extends !== "string")
        throw new Error("extends must name a permission profile");
      if (profile.extends === ":danger-full-access")
        throw new Error("cannot extend :danger-full-access");
      this.validateProfile(document, profile.extends, ancestors);
    }
    if (profile.filesystem !== undefined) {
      if (!this.isTable(profile.filesystem))
        this.invalid(document, ["permissions", name, "filesystem"], "filesystem must be a table");
      for (const [path, access] of Object.entries(profile.filesystem)) {
        if (path === "glob_scan_max_depth") {
          if (!Number.isInteger(access) || (access as number) < 1)
            throw new Error("glob_scan_max_depth must be a positive integer");
          continue;
        }
        const permissions = this.isTable(access) ? Object.values(access) : [access];
        if (
          !permissions.every(
            (permission) =>
              permission === "read" || permission === "write" || permission === "deny",
          )
        ) {
          this.invalid(
            document,
            ["permissions", name, "filesystem", path],
            "filesystem access must be read, write or deny",
          );
        }
      }
    }
    if (profile.network !== undefined) {
      if (!this.isTable(profile.network))
        this.invalid(document, ["permissions", name, "network"], "network must be a table");
      if (profile.network.enabled !== undefined && typeof profile.network.enabled !== "boolean")
        this.invalid(
          document,
          ["permissions", name, "network", "enabled"],
          "network.enabled must be a boolean",
        );
    }
  }

  private invalid(document: TomlDocument, path: readonly string[], reason: string): never {
    const line = document.line(path);
    throw new Error(`${reason}${line === undefined ? "" : ` at line ${line}`}`);
  }

  private isTable(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Date)
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
      this.invalid(document, ["sandbox_mode"], "sandbox_mode must be a supported sandbox mode");
    }
    const sandbox = configuration.sandbox_workspace_write;
    if (
      sandbox !== undefined &&
      (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox))
    ) {
      this.invalid(
        document,
        ["sandbox_workspace_write"],
        "sandbox_workspace_write must be a table",
      );
    }
    const network = document.value(["sandbox_workspace_write", "network_access"]);
    if (network !== undefined && typeof network !== "boolean")
      this.invalid(
        document,
        ["sandbox_workspace_write", "network_access"],
        "network_access must be a boolean",
      );
    const roots = document.value(["sandbox_workspace_write", "writable_roots"]);
    if (
      roots !== undefined &&
      (!Array.isArray(roots) || !roots.every((root) => typeof root === "string"))
    ) {
      this.invalid(
        document,
        ["sandbox_workspace_write", "writable_roots"],
        "writable_roots must be an array of strings",
      );
    }
  }
}
