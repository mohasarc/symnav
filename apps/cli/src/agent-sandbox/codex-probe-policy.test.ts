import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexSandboxConfiguration } from "./codex-configuration.js";
import { TomlDocument } from "./toml-document.js";

class ProbePolicyScratch {
  public static readonly directories: string[] = [];
}
afterEach(async () => {
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
