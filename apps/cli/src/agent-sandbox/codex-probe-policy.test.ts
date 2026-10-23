import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexSandboxConfiguration } from "./codex-configuration.js";
import { TomlDocument } from "./toml-document.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
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
    directories.push(home);
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
