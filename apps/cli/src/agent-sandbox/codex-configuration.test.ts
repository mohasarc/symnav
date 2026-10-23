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
});
