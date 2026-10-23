import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexSandboxConfiguration } from "./codex-configuration.js";
import { TomlDocument } from "./toml-document.js";

class ProbePolicyScratch {
  public static readonly directories: string[] = [];
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    ProbePolicyScratch.directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
it.each([
  [
    'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nwritable_roots = ["/state"]',
    true,
  ],
  ['sandbox_mode = "read-only"\n[sandbox_workspace_write]\nwritable_roots = ["/state"]', false],
  ['default_permissions = ":read-only"', false],
  ['default_permissions = ":danger-full-access"', true],
  [
    'default_permissions = "child"\n[permissions.base]\nextends = ":read-only"\nfilesystem."/state" = { "." = "write", denied = "deny" }\n[permissions.child]\nextends = "base"',
    true,
  ],
  [
    'default_permissions = "child"\n[permissions.base]\nextends = ":read-only"\nfilesystem."/state" = "write"\n[permissions.child]\nextends = "base"\nfilesystem."/state/sub" = "deny"',
    false,
  ],
] as const)(
  "inspects effective state grants without copying unrelated configuration: %s",
  async (policy, granted) => {
    const home = await mkdtemp(join(tmpdir(), "codex-probe-"));
    ProbePolicyScratch.directories.push(home);
    const adapter = new CodexSandboxConfiguration({ homeDirectory: home });
    await mkdir(join(home, ".codex"));
    const original = `${policy}\nmodel = "private"\n`;
    await writeFile(adapter.configurationPath, original);
    const result = await adapter.inspect("/state/sub", "/state/doctor/random/workspace");
    expect(result.grantsState).toBe(granted);
    const document = new TomlDocument(result.configuration);
    expect(document.value(["permissions", "symnav-doctor", "network", "enabled"])).toBe(false);
    expect(result.configuration).not.toContain("private");
    expect(result.configuration).not.toContain('"/state/sub" = "write"');
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  },
);

it("keeps scoped special roots at their original absolute locations and never grants scratch state", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-special-"));
  ProbePolicyScratch.directories.push(home);
  const workspace = join(home, "original");
  const scratch = join(home, "state", "doctor", "id", "workspace");
  const adapter = new CodexSandboxConfiguration({
    homeDirectory: home,
    workspaceDirectory: workspace,
    codexHome: join(home, "configuration"),
  });
  await mkdir(join(home, "configuration"));
  await writeFile(
    adapter.configurationPath,
    `default_permissions = "child"\n[permissions.base]\nextends = ":read-only"\n[permissions.base.workspace_roots]\n"~/extra" = true\n[permissions.base.filesystem.\":workspace_roots\"]\n\".\" = "write"\nsecret = "deny"\n[permissions.child]\nextends = "base"\n[permissions.child.filesystem]\n\"~/configuration\" = "deny"\n\":tmpdir\" = "read"\n`,
  );
  const result = await adapter.inspect(join(workspace, "state"), scratch);
  expect(result.grantsState).toBe(true);
  const doc = new TomlDocument(result.configuration);
  const filesystem = doc.value(["permissions", "symnav-doctor", "filesystem"]) as Record<
    string,
    unknown
  >;
  expect(filesystem[workspace]).toEqual({ ".": "write", secret: "deny" });
  expect(filesystem[join(home, "extra")]).toEqual({ ".": "write", secret: "deny" });
  expect(filesystem[join(home, "configuration")]).toBe("deny");
  expect(filesystem[scratch]).toBe("read");
  expect(result.configuration).not.toContain(":workspace_roots");
  expect(result.configuration).not.toContain("probe-state");
});
it("does not add a root-read baseline to a custom profile with no parent", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-restricted-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new CodexSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".codex"));
  await writeFile(
    adapter.configurationPath,
    'default_permissions="strict"\n[permissions.strict.filesystem]\n":minimal"="read"\n"/state"="write"\n',
  );
  const result = await adapter.inspect("/state", "/state/doctor/id/workspace");
  const doc = new TomlDocument(result.configuration);
  expect(doc.value(["permissions", "symnav-doctor", "extends"])).toBeUndefined();
  expect(doc.value(["permissions", "symnav-doctor", "filesystem", ":root"])).toBeUndefined();
  expect(doc.value(["permissions", "symnav-doctor", "filesystem", ":minimal"])).toBe("read");
});
it("preserves builtin workspace grants and equal-path permission precedence", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-builtin-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new CodexSandboxConfiguration({ homeDirectory: home, workspaceDirectory: home });
  await mkdir(join(home, ".codex"));
  await writeFile(
    adapter.configurationPath,
    'default_permissions="selected"\n[permissions.selected]\nextends=":workspace"\nfilesystem."/"="write"\n',
  );
  const inspected = await adapter.inspect(join(home, "state"), "/scratch/workspace");
  expect(inspected.grantsState).toBe(true);
  expect(
    new TomlDocument(inspected.configuration).value([
      "permissions",
      "symnav-doctor",
      "filesystem",
      home,
    ]),
  ).toMatchObject({ ".": "write", ".codex": "read" });
});
it("keeps legacy workspace-write permissions at the original workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-legacy-workspace-"));
  ProbePolicyScratch.directories.push(home);
  const original = join(home, "original");
  const adapter = new CodexSandboxConfiguration({
    homeDirectory: home,
    workspaceDirectory: original,
  });
  await mkdir(join(home, ".codex"));
  await writeFile(
    adapter.configurationPath,
    'sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nwritable_roots=[]\nexclude_tmpdir_env_var=true\nexclude_slash_tmp=true\n',
  );
  const result = await adapter.inspect(join(original, "state"), join(home, "scratch", "workspace"));
  expect(result.grantsState).toBe(true);
  const filesystem = new TomlDocument(result.configuration).value([
    "permissions",
    "symnav-doctor",
    "filesystem",
  ]) as Record<string, unknown>;
  expect(filesystem[original]).toMatchObject({ ".": "write", ".codex": "read" });
  expect(result.configuration).not.toContain(":tmpdir");
});

it("checks an existing grant through its canonical filesystem path", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-alias-"));
  ProbePolicyScratch.directories.push(home);
  const physical = join(home, "physical");
  const alias = join(home, "alias");
  await mkdir(physical);
  await symlink(physical, alias, "junction");
  const adapter = new CodexSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".codex"));
  await writeFile(
    adapter.configurationPath,
    `sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(alias)}]\nexclude_tmpdir_env_var=true\nexclude_slash_tmp=true\n`,
  );
  expect(
    (await adapter.inspect(join(physical, "state"), join(physical, "doctor", "workspace")))
      .grantsState,
  ).toBe(true);
});

it.each(["legacy", "named"])(
  "does not replace missing TMPDIR with OS, TMP or TEMP fallback for %s policy",
  async (style) => {
    const home = await mkdtemp(join(tmpdir(), "codex-tmpdir-absence-"));
    ProbePolicyScratch.directories.push(home);
    await mkdir(join(home, ".codex"));
    vi.stubEnv("TMPDIR", undefined);
    vi.stubEnv("TMP", undefined);
    vi.stubEnv("TEMP", undefined);
    const fallback = tmpdir();
    const state = join(fallback, "outside-original-workspace", "state");
    vi.stubEnv("TMP", fallback);
    vi.stubEnv("TEMP", fallback);
    const adapter = new CodexSandboxConfiguration({
      homeDirectory: home,
      workspaceDirectory: join(home, "project"),
    });
    const original =
      style === "legacy"
        ? 'sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nexclude_slash_tmp=true\nwritable_roots=[]\n'
        : 'default_permissions="selected"\n[permissions.selected]\nextends=":read-only"\nfilesystem.":tmpdir"="write"\n';
    await writeFile(adapter.configurationPath, original);
    const result = await adapter.inspect(state, join(home, "doctor", "workspace"));
    expect(result.grantsState).toBe(false);
    expect(
      new TomlDocument(result.configuration).value([
        "permissions",
        "symnav-doctor",
        "filesystem",
        fallback,
      ]),
    ).toBeUndefined();
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  },
);
it.each(["", "relative/tmp"])("does not turn invalid TMPDIR %s into a grant", async (temporary) => {
  const home = await mkdtemp(join(tmpdir(), "codex-tmpdir-invalid-"));
  ProbePolicyScratch.directories.push(home);
  await mkdir(join(home, ".codex"));
  vi.stubEnv("TMPDIR", temporary);
  const adapter = new CodexSandboxConfiguration({
    homeDirectory: home,
    workspaceDirectory: join(home, "project"),
  });
  await writeFile(
    adapter.configurationPath,
    'default_permissions="selected"\n[permissions.selected]\nextends=":read-only"\nfilesystem.":tmpdir"="write"\n',
  );
  const result = await adapter.inspect(
    join(home, "outside", "state"),
    join(home, "doctor", "workspace"),
  );
  expect(result.grantsState).toBe(false);
  expect(
    Object.values(
      new TomlDocument(result.configuration).value([
        "permissions",
        "symnav-doctor",
        "filesystem",
      ]) as Record<string, unknown>,
    ),
  ).not.toContain("write");
});
it.each(["legacy", "named"])(
  "materializes only the original explicit TMPDIR for %s policy",
  async (style) => {
    const home = await mkdtemp(join(tmpdir(), "codex-tmpdir-present-"));
    ProbePolicyScratch.directories.push(home);
    await mkdir(join(home, ".codex"));
    const temporary = join(home, "original-temp");
    await mkdir(temporary);
    vi.stubEnv("TMPDIR", temporary);
    vi.stubEnv("TMP", join(home, "wrong-tmp"));
    vi.stubEnv("TEMP", join(home, "wrong-temp"));
    const adapter = new CodexSandboxConfiguration({
      homeDirectory: home,
      workspaceDirectory: join(home, "project"),
    });
    await writeFile(
      adapter.configurationPath,
      style === "legacy"
        ? 'sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nexclude_slash_tmp=true\nwritable_roots=[]\n'
        : 'default_permissions="selected"\n[permissions.selected]\nextends=":read-only"\nfilesystem.":tmpdir"="write"\n',
    );
    const state = join(temporary, "state");
    const result = await adapter.inspect(state, join(home, "doctor", "workspace"));
    expect(result.grantsState).toBe(true);
    const filesystem = new TomlDocument(result.configuration).value([
      "permissions",
      "symnav-doctor",
      "filesystem",
    ]) as Record<string, unknown>;
    expect(filesystem[temporary]).toBe("write");
    expect(filesystem[state]).toBeUndefined();
  },
);
