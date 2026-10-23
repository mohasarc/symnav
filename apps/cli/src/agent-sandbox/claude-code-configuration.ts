import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentSandboxConfiguration,
  type AgentConfigurationLocations,
  type AgentSetupResult,
} from "./agent-configuration.js";
import { AgentConfigurationFile } from "./agent-configuration-file.js";
import type { AgentProbePolicy } from "./agent-probe-policy.js";
import { AgentExecutable } from "./agent-executable.js";

export class ClaudeCodeSandboxConfiguration extends AgentSandboxConfiguration {
  public readonly agent = "claude-code";
  public readonly configurationPath: string;

  private readonly homeDirectory: string;

  public constructor(locations: AgentConfigurationLocations) {
    super();
    this.homeDirectory = locations.homeDirectory;
    this.configurationPath = join(
      locations.claudeConfigurationDirectory ?? join(locations.homeDirectory, ".claude"),
      "settings.json",
    );
  }

  public async inspect(stateDirectory: string, _workspace: string): Promise<AgentProbePolicy> {
    const source = await new AgentConfigurationFile(this.configurationPath).read();
    const root = this.validateSettings(source || "{}");
    const enabled = findNodeAtLocation(root, ["sandbox", "enabled"]);
    if (enabled !== undefined && enabled.type !== "boolean")
      throw new Error("sandbox.enabled must be a boolean");
    const filesystem: Record<string, string[]> = {};
    for (const key of ["allowWrite", "denyWrite", "denyRead"]) {
      const node = findNodeAtLocation(root, ["sandbox", "filesystem", key]);
      if (
        node !== undefined &&
        (node.type !== "array" || node.children?.some((child) => child.type !== "string"))
      )
        throw new Error(`sandbox.filesystem.${key} must be an array of strings`);
      filesystem[key] = (node?.children ?? []).map((child) => {
        const path = child.value as string;
        return path === "~" || path.startsWith("~/")
          ? join(this.homeDirectory, path.slice(2))
          : path;
      });
    }
    const denied = [...filesystem.denyWrite!, ...filesystem.denyRead!].some(
      (path) => this.covers(path, stateDirectory) || /[*?\[\]{}]/u.test(path),
    );
    return {
      grantsState:
        !denied && filesystem.allowWrite!.some((path) => this.covers(path, stateDirectory)),
      configuration: JSON.stringify({
        network: { allowedDomains: [], deniedDomains: ["*"] },
        filesystem,
      }),
    };
  }

  public async grant(stateDirectory: string): Promise<AgentSetupResult> {
    try {
      const file = new AgentConfigurationFile(this.configurationPath);
      const original = await file.read();
      const updated =
        original.length === 0 && !(await this.settingsExist())
          ? `${JSON.stringify({ sandbox: { filesystem: { allowWrite: [stateDirectory] } } }, null, 2)}\n`
          : this.addGrant(original, stateDirectory);
      const changed = updated !== original;
      if (changed) {
        this.validateSettings(updated);
        await file.publish(original, updated);
      }
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
    const root = this.validateSettings(original);
    const path = ["sandbox", "filesystem", "allowWrite"];
    const grants = findNodeAtLocation(root, path)?.children ?? [];
    if (
      grants.some(
        (grant) => typeof grant.value === "string" && this.covers(grant.value, stateDirectory),
      )
    )
      return original;
    const updated = applyEdits(original, modify(original, [...path, -1], stateDirectory, {}));
    return updated;
  }
  private covers(grant: string, stateDirectory: string): boolean {
    if (grant === stateDirectory) return true;
    const expanded =
      grant === "~"
        ? this.homeDirectory
        : grant.startsWith("~/")
          ? join(this.homeDirectory, grant.slice(2))
          : grant;
    if (!isAbsolute(expanded) || /[*?\[\]{}]/u.test(expanded)) return false;
    const remainder = relative(resolve(expanded), resolve(stateDirectory));
    return (
      remainder === "" ||
      (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))
    );
  }
  private async settingsExist(): Promise<boolean> {
    try {
      await lstat(this.configurationPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private validateSettings(source: string): Node {
    const errors: ParseError[] = [];
    const root = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
    if (root === undefined || errors.length > 0)
      throw new Error(`invalid JSON at line ${this.line(source, errors[0]?.offset ?? 0)}`);
    this.validateUniqueKeys(root, source);
    if (root.type !== "object") throw new Error("settings must be an object");
    for (const path of [["sandbox"], ["sandbox", "filesystem"]]) {
      const node = findNodeAtLocation(root, path);
      if (node !== undefined && node.type !== "object")
        throw new Error(`${path.join(".")} must be an object`);
    }
    const grants = findNodeAtLocation(root, ["sandbox", "filesystem", "allowWrite"]);
    if (
      grants !== undefined &&
      (grants.type !== "array" || grants.children?.some((node) => node.type !== "string"))
    )
      throw new Error("sandbox.filesystem.allowWrite must be an array of strings");
    return root;
  }

  private validateUniqueKeys(node: Node, source: string): void {
    const names = new Set<string>();
    for (const child of node.children ?? []) {
      if (node.type === "object") {
        const key = child.children![0]!;
        const name = key.value as string;
        if (names.has(name))
          throw new Error(`duplicate JSON key at line ${this.line(source, key.offset)}`);
        names.add(name);
      }
      this.validateUniqueKeys(child, source);
    }
  }

  private line(source: string, offset: number): number {
    return source.slice(0, offset).split(/\r\n|\r|\n/u).length;
  }
}
