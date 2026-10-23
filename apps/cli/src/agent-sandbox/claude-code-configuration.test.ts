import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeSandboxConfiguration } from "./claude-code-configuration.js";

describe("ClaudeCodeSandboxConfiguration", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates missing user settings with only the effective state grant and leaves repeat bytes intact", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-claude-setup-"));
    directories.push(homeDirectory);
    vi.stubEnv("PATH", "");
    const configuration = new ClaudeCodeSandboxConfiguration({ homeDirectory });
    const stateDirectory = join(homeDirectory, 'state 雪 "escaped"');
    expect(await configuration.grant(stateDirectory)).toEqual({
      agent: "claude-code",
      stateDirectory,
      configurationPath: join(homeDirectory, ".claude", "settings.json"),
      changed: true,
      installed: false,
    });
    const original = await readFile(configuration.configurationPath, "utf8");
    expect(JSON.parse(original)).toEqual({
      sandbox: { filesystem: { allowWrite: [stateDirectory] } },
    });
    expect(await configuration.grant(stateDirectory)).toMatchObject({ changed: false });
    expect(await readFile(configuration.configurationPath, "utf8")).toBe(original);
  });
});
