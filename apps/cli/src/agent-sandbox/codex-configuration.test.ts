import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSandboxConfiguration } from "./codex-configuration.js";

describe("CodexSandboxConfiguration", () => {
  const scratchDirectories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates missing user config with only the state write grant and changes nothing on repeat", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-setup-"));
    scratchDirectories.push(homeDirectory);
    vi.stubEnv("PATH", "");
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    const stateDirectory = join(homeDirectory, "custom state 雪");
    const expected = `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(stateDirectory)}]\n`;
    expect(await adapter.grant(stateDirectory)).toEqual({
      agent: "codex",
      stateDirectory,
      configurationPath: join(homeDirectory, ".codex", "config.toml"),
      changed: true,
      installed: false,
    });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(expected);
    expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: false });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(expected);
  });
  it.each([
    [
      "table",
      '# keep\nsandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = false # stay\nwritable_roots = ["/other"] # roots\n[model]\nname = "雪"\n',
    ],
    [
      "multiline",
      '[sandbox_workspace_write]\nwritable_roots = [\n  "/other", # retain\n] # after\n',
    ],
    [
      "inline",
      'sandbox_workspace_write = { network_access = false, writable_roots = ["/other"] } # keep\n',
    ],
    ["dotted", 'sandbox_workspace_write.writable_roots = ["/other"]\n'],
    ["quoted", '["sandbox_workspace_write"]\n"writable_roots" = ["/other"]\n'],
    ["empty inline", "sandbox_workspace_write = {}\n"],
    ["missing key", "[sandbox_workspace_write]\nnetwork_access = false\n"],
    ["missing table", '# keep\nmodel = "unchanged"\n[features]\nnetwork_proxy = false\n'],
    ["CRLF", '[sandbox_workspace_write]\r\nwritable_roots = ["/other"] # keep\r\n'],
  ])("preserves legacy %s config and adds one effective state root", async (_name, original) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-preserve-"));
    scratchDirectories.push(homeDirectory);
    const adapter = new CodexSandboxConfiguration({
      homeDirectory,
      codexHome: join(homeDirectory, "custom-codex"),
    });
    const stateDirectory = join(homeDirectory, "state");
    await mkdir(join(homeDirectory, "custom-codex"));
    await writeFile(adapter.configurationPath, original);
    expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: true });
    const updated = await readFile(adapter.configurationPath, "utf8");
    expect(updated).toContain(JSON.stringify(stateDirectory));
    const withoutAddedRoot = updated.replace(`, ${JSON.stringify(stateDirectory)}`, "");
    if (original.includes('["/other"]')) expect(withoutAddedRoot).toBe(original);
    for (const comment of ["# keep", "# retain", "# after", "# roots", "# stay"]) {
      if (original.includes(comment)) expect(updated).toContain(comment);
    }
    expect(updated).toContain(
      original.includes("network_access = false") ? "network_access = false" : "",
    );
    expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: false });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(updated);
  });
  it.each([
    ["malformed", "[sandbox_workspace_write\nwritable_roots = []\n", "invalid TOML at line 2"],
    ["duplicate key", "model = 'a'\nmodel = 'b'\n", "invalid TOML at line 2"],
    ["duplicate table", "[x]\n[x]\n", "invalid TOML at line 2"],
    ["wrong table", "sandbox_workspace_write = 1\n", "sandbox_workspace_write must be a table"],
    [
      "wrong roots",
      "[sandbox_workspace_write]\nwritable_roots = 'all'\n",
      "writable_roots must be an array of strings",
    ],
    [
      "wrong element",
      "[sandbox_workspace_write]\nwritable_roots = [42]\n",
      "writable_roots must be an array of strings",
    ],
    ["wrong mode", "sandbox_mode = 42\n", "sandbox_mode must be a supported sandbox mode"],
    [
      "conflicting policies",
      "default_permissions = ':workspace'\nsandbox_mode = 'workspace-write'\n",
      "legacy sandbox settings conflict with permission profiles",
    ],
  ])("rejects %s without changing the file", async (_name, original, reason) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-invalid-"));
    scratchDirectories.push(homeDirectory);
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    await mkdir(join(homeDirectory, ".codex"));
    await writeFile(adapter.configurationPath, original);
    await expect(adapter.grant(join(homeDirectory, "state"))).rejects.toThrow(
      `cannot update ${adapter.configurationPath}: ${reason}`,
    );
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  });
  it.each(["table", "inline", "dotted", "inherited", "built-in"])(
    "grants only state in a selected %s permission profile",
    async (style) => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-profile-"));
      scratchDirectories.push(homeDirectory);
      const stateDirectory = join(homeDirectory, "state");
      const selected = style === "built-in" ? ":workspace" : "custom profile";
      const headers = `default_permissions = ${JSON.stringify(selected)} # selection\nmodel = "keep"\n`;
      const policies: Record<string, string> = {
        table:
          '[permissions."custom profile"]\nextends = ":workspace"\n[permissions."custom profile".filesystem]\n"/unrelated" = "write" # grant\n"/secret" = "deny" # deny\n[permissions."custom profile".network]\nenabled = false # network\n',
        inline:
          'permissions = { "custom profile" = { extends = ":workspace", filesystem = { "/unrelated" = "write", "/secret" = "deny" }, network = { enabled = false } } } # keep\n',
        dotted:
          'permissions."custom profile".extends = ":workspace"\npermissions."custom profile".filesystem."/unrelated" = "write"\npermissions."custom profile".network.enabled = false\n',
        inherited:
          '[permissions.base]\nextends = ":workspace"\nfilesystem = { "/unrelated" = "write", "/secret" = "deny" }\nnetwork = { enabled = false }\n[permissions."custom profile"]\nextends = "base"\n',
        "built-in": "[features]\nnetwork_proxy = false # keep\n",
      };
      const original = headers + policies[style];
      const adapter = new CodexSandboxConfiguration({ homeDirectory });
      await mkdir(join(homeDirectory, ".codex"));
      await writeFile(adapter.configurationPath, original);
      expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: true });
      const updated = await readFile(adapter.configurationPath, "utf8");
      const result = getStaticTOMLValue(parseTOML(updated)) as {
        default_permissions: string;
        permissions: Record<string, { extends?: string; filesystem: Record<string, string> }>;
      };
      expect(result.permissions[result.default_permissions]!.filesystem[stateDirectory]).toBe(
        "write",
      );
      expect(updated).not.toContain("sandbox_workspace_write");
      if (style !== "built-in") {
        let firstChange = 0;
        while (original[firstChange] === updated[firstChange]) firstChange += 1;
        expect(
          updated.slice(0, firstChange) +
            updated.slice(firstChange + updated.length - original.length),
        ).toBe(original);

        expect(result.default_permissions).toBe(selected);
        expect(updated).toContain(
          policies[style]!.includes("enabled = false") ? "enabled = false" : "enabled = false",
        );
        expect(updated).toContain(headers);
      } else expect(result.permissions[result.default_permissions]!.extends).toBe(":workspace");
      expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: false });
      expect(await readFile(adapter.configurationPath, "utf8")).toBe(updated);
    },
  );
  it.each([
    [
      "legacy broad",
      (home: string) =>
        `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(home)}] # broad\n`,
    ],
    ["legacy home", () => '[sandbox_workspace_write]\nwritable_roots = ["~/"]\n'],
    ["legacy unrestricted", () => "sandbox_mode = 'danger-full-access'\n"],
    ["named unrestricted", () => "default_permissions = ':danger-full-access'\n"],
    [
      "inherited broad",
      (home: string) =>
        `default_permissions = "child"\n[permissions.parent.filesystem]\n${JSON.stringify(home)} = 'write' # broad\n[permissions.child]\nextends = "parent"\n`,
    ],
    [
      "exact single quotes",
      (home: string) =>
        `default_permissions = "p"\n[permissions.p.filesystem]\n${JSON.stringify(join(home, "state"))} = 'write'\n`,
    ],
    [
      "scoped broad",
      (home: string) =>
        `default_permissions = "p"\n[permissions.p.filesystem.${JSON.stringify(home)}]\n"." = "write"\n"secret" = "deny"\n`,
    ],
  ])("retains byte-identical %s grants", async (_name, configuration) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-broad-"));
    scratchDirectories.push(homeDirectory);
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    await mkdir(join(homeDirectory, ".codex"));
    const original = configuration(homeDirectory);
    await writeFile(adapter.configurationPath, original);
    expect(await adapter.grant(join(homeDirectory, "state"))).toMatchObject({ changed: false });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  });
  it.each([
    [
      "missing selection",
      "permissions = {}\n",
      "default_permissions must select a permission profile",
    ],
    [
      "wrong selection",
      "default_permissions = 42\n",
      "default_permissions must select a permission profile",
    ],
    ["missing profile", 'default_permissions = "absent"\n', "unknown permission profile: absent"],
    [
      "wrong profiles",
      'default_permissions = "p"\npermissions = []\n',
      "permissions must be a table",
    ],
    [
      "wrong profile",
      'default_permissions = "p"\npermissions.p = true\n',
      "permission profile p must be a table",
    ],
    [
      "wrong filesystem",
      'default_permissions = "p"\n[permissions.p]\nfilesystem = []\n',
      "filesystem must be a table",
    ],
    [
      "wrong access",
      'default_permissions = "p"\n[permissions.p.filesystem]\n"/other" = true\n',
      "filesystem access must be read, write or deny",
    ],
    [
      "wrong scoped access",
      'default_permissions = "p"\n[permissions.p.filesystem."/other"]\n"." = 42\n',
      "filesystem access must be read, write or deny",
    ],
    [
      "wrong parent",
      'default_permissions = "p"\n[permissions.p]\nextends = 42\n',
      "extends must name a permission profile",
    ],
    [
      "unknown parent",
      'default_permissions = "p"\n[permissions.p]\nextends = "absent"\n',
      "unknown permission profile: absent",
    ],
    [
      "cycle",
      'default_permissions = "p"\n[permissions.p]\nextends = "p"\n',
      "permission profile inheritance cycle",
    ],
    [
      "unrestricted parent",
      'default_permissions = "p"\n[permissions.p]\nextends = ":danger-full-access"\n',
      "cannot extend :danger-full-access",
    ],
    [
      "wrong network",
      'default_permissions = "p"\n[permissions.p]\nnetwork = false\n',
      "network must be a table",
    ],
    [
      "wrong enabled",
      'default_permissions = "p"\n[permissions.p.network]\nenabled = "false"\n',
      "network.enabled must be a boolean",
    ],
  ])("rejects %s named policy unchanged", async (_name, original, reason) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-policy-error-"));
    scratchDirectories.push(homeDirectory);
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    await mkdir(join(homeDirectory, ".codex"));
    await writeFile(adapter.configurationPath, original);
    await expect(adapter.grant(join(homeDirectory, "state"))).rejects.toThrow(reason);
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  });

  it.each([false, true])("preserves %s inherited denial on the state path", async (inherited) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-deny-"));
    scratchDirectories.push(homeDirectory);
    const stateDirectory = join(homeDirectory, "state");
    const original =
      `default_permissions = "p"\n[permissions.${inherited ? "base" : "p"}.filesystem]\n${JSON.stringify(stateDirectory)} = "deny" # keep\n` +
      (inherited ? '[permissions.p]\nextends = "base"\n' : "");
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    await mkdir(join(homeDirectory, ".codex"));
    await writeFile(adapter.configurationPath, original);
    await expect(adapter.grant(stateDirectory)).rejects.toThrow(
      "state directory has an explicit deny rule",
    );
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  });
  it.each(["inherited scoped", "child scoped", "nearest scoped", "nearest scalar"])(
    "resolves %s filesystem entries before granting state across inheritance",
    async (style) => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-inheritance-"));
      scratchDirectories.push(homeDirectory);
      const adapter = new CodexSandboxConfiguration({ homeDirectory });
      const stateDirectory = join(homeDirectory, "state");
      const key = JSON.stringify(stateDirectory);
      const scoped = `{ "." = "read", secret = "deny", nested = "read" }`;
      const base =
        style === "child scoped"
          ? '"write"'
          : style.startsWith("nearest")
            ? `{ "." = "write", stale = "deny" }`
            : scoped;
      const middle = style === "nearest scoped" ? scoped : '"read"';
      const original = `default_permissions = "child" # selection\n[permissions.base]\nextends = ":read-only"\nfilesystem.${key} = ${base} # ancestor\nnetwork.enabled = false # network\n[permissions.middle]\nextends = "base"\n${style.startsWith("nearest") ? `filesystem.${key} = ${middle} # replacement\n` : ""}[permissions.child]\nextends = "middle"\n${style === "child scoped" ? `filesystem.${key} = ${scoped} # child\n` : ""}`;
      await mkdir(join(homeDirectory, ".codex"));
      await writeFile(adapter.configurationPath, original);
      expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: true });
      const updated = await readFile(adapter.configurationPath, "utf8");
      const configuration = getStaticTOMLValue(parseTOML(updated)) as {
        permissions: Record<string, { filesystem?: Record<string, unknown> }>;
      };
      expect(configuration.permissions.child!.filesystem![stateDirectory]).toEqual(
        style === "nearest scalar"
          ? "write"
          : style === "child scoped"
            ? { ".": "write", secret: "deny", nested: "read" }
            : { ".": "write" },
      );
      if (style === "child scoped")
        expect(updated).toBe(original.replace('"read", secret', '"write", secret'));
      else expect(updated.startsWith(original)).toBe(true);
      expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: false });
      expect(await readFile(adapter.configurationPath, "utf8")).toBe(updated);
    },
  );

  it("preserves scoped state denies when upgrading only the state access value", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-scoped-"));
    scratchDirectories.push(homeDirectory);
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    const stateDirectory = join(homeDirectory, "state");
    const original = `default_permissions = "p"\n[permissions.p.filesystem.${JSON.stringify(stateDirectory)}]\n"." = "read" # state\n"secret" = "deny" # keep\n[permissions.p.network]\nenabled = true\n`;
    await mkdir(join(homeDirectory, ".codex"));
    await writeFile(adapter.configurationPath, original);
    expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: true });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(
      original.replace('"read" # state', '"write" # state'),
    );
    expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: false });
  });

  it("retains read and deny root rules while adding only the state path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-root-"));
    scratchDirectories.push(homeDirectory);
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    const stateDirectory = join(homeDirectory, "state");
    const original =
      'default_permissions = "p"\n[permissions.p.filesystem]\n":root" = "deny" # preserve\n":minimal" = "read"\n[permissions.p.network]\nenabled = false\n';
    await mkdir(join(homeDirectory, ".codex"));
    await writeFile(adapter.configurationPath, original);
    await adapter.grant(stateDirectory);
    const expected = original.replace(
      "[permissions.p.network]",
      `${JSON.stringify(stateDirectory)} = "write"\n[permissions.p.network]`,
    );
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(expected);
  });
});
