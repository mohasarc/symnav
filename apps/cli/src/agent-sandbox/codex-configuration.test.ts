import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSandboxConfiguration } from "./codex-configuration.js";

describe("CodexSandboxConfiguration", () => {
  const scratchDirectories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("creates missing user config with only the state write grant and changes nothing on repeat", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-codex-setup-"));
    scratchDirectories.push(homeDirectory);
    vi.stubEnv("PATH", "");
    const adapter = new CodexSandboxConfiguration({ homeDirectory });
    const stateDirectory = join(homeDirectory, "custom state 雪");
    const expected = `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(stateDirectory)}]\n`;
    expect(await adapter.grant(stateDirectory)).toEqual({
      agent: "codex", stateDirectory, configurationPath: join(homeDirectory, ".codex", "config.toml"), changed: true, installed: false,
    });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(expected);
    expect(await adapter.grant(stateDirectory)).toMatchObject({ changed: false });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(expected);
  });
});
