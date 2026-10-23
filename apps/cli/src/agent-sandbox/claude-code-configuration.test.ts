import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it.each([
    "{}",
    '{"sandbox": {"enabled": false}}',
    '{"sandbox": {"filesystem": {"denyWrite": ["/secret"]}}}',
    '{"theme":"dark","sandbox":{"enabled":true,"network":{"allowedDomains":[]},"filesystem":{"allowWrite":["/other"],"denyRead":["/private"],"denyWrite":["/secret"]}},"permissions":{"deny":["Edit(/secret)"]}}',
    '{\r\n\t"sandbox": {"filesystem": {"allowWrite": [\r\n\t\t"/other"\r\n\t]}},\r\n\t"theme": "雪"\r\n}\r\n',
  ])("adds only a source-range state grant to existing settings %s", async (original) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-claude-preserve-"));
    directories.push(homeDirectory);
    const configuration = new ClaudeCodeSandboxConfiguration({ homeDirectory });
    const stateDirectory = join(homeDirectory, 'state 雪 "escaped"');
    await mkdir(join(homeDirectory, ".claude"));
    await writeFile(configuration.configurationPath, original);
    expect(await configuration.grant(stateDirectory)).toMatchObject({ changed: true });
    const updated = await readFile(configuration.configurationPath, "utf8");
    const expected = JSON.parse(original);
    expected.sandbox ??= {};
    expected.sandbox.filesystem ??= {};
    expected.sandbox.filesystem.allowWrite ??= [];
    expected.sandbox.filesystem.allowWrite.push(stateDirectory);
    expect(JSON.parse(updated)).toEqual(expected);
    if (original.includes('"/other"')) {
      expect(updated.replace(`,${JSON.stringify(stateDirectory)}`, "")).toBe(original);
    }
    expect(await configuration.grant(stateDirectory)).toMatchObject({ changed: false });
    expect(await readFile(configuration.configurationPath, "utf8")).toBe(updated);
  });
  it.each(["exact", "parent", "tilde", "normalized", "literal brackets", "sibling"])(
    "recognizes %s existing write grants under a custom config root",
    async (style) => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-claude-existing-"));
      directories.push(homeDirectory);
      const claudeConfigurationDirectory = join(homeDirectory, "custom claude 雪");
      const configuration = new ClaudeCodeSandboxConfiguration({
        homeDirectory,
        claudeConfigurationDirectory,
      });
      expect(configuration.configurationPath).toBe(
        join(claudeConfigurationDirectory, "settings.json"),
      );
      await mkdir(claudeConfigurationDirectory);
      const stateDirectory = join(
        homeDirectory,
        style === "literal brackets" ? "state [draft]" : "state",
      );
      const grant =
        style === "parent"
          ? homeDirectory
          : style === "tilde"
            ? "~/state/"
            : style === "normalized"
              ? `${stateDirectory}/../state/`
              : style === "sibling"
                ? `${stateDirectory}-other`
                : stateDirectory;
      const original = JSON.stringify({ sandbox: { filesystem: { allowWrite: [grant] } } });
      await writeFile(configuration.configurationPath, original);
      expect(await configuration.grant(stateDirectory)).toMatchObject({
        changed: style === "sibling",
      });
      if (style !== "sibling")
        expect(await readFile(configuration.configurationPath, "utf8")).toBe(original);
    },
  );
  it.each([
    ["empty", "", "invalid JSON at line 1"],
    ["malformed", '{\n "sandbox":', "invalid JSON at line 2"],
    ["comment", "{/* comment */}", "invalid JSON at line 1"],
    ["trailing comma", '{"sandbox":{},}', "invalid JSON at line 1"],
    ["array root", "[]", "settings must be an object"],
    ["null root", "null", "settings must be an object"],
    ["scalar root", "true", "settings must be an object"],
    ["sandbox null", '{"sandbox":null}', "sandbox must be an object"],
    ["sandbox array", '{"sandbox":[]}', "sandbox must be an object"],
    [
      "filesystem scalar",
      '{"sandbox":{"filesystem":false}}',
      "sandbox.filesystem must be an object",
    ],
    [
      "allowWrite scalar",
      '{"sandbox":{"filesystem":{"allowWrite":"/tmp"}}}',
      "sandbox.filesystem.allowWrite must be an array of strings",
    ],
    [
      "allowWrite element",
      '{"sandbox":{"filesystem":{"allowWrite":[false]}}}',
      "sandbox.filesystem.allowWrite must be an array of strings",
    ],
    ["duplicate root", '{\n "theme":1,\n "theme":2}', "duplicate JSON key at line 3"],
    [
      "duplicate nested",
      '{"sandbox":{"filesystem":{"allowWrite":[],"allowWrite":[]}}}',
      "duplicate JSON key at line 1",
    ],
    ["escaped duplicate", '{"theme":1,"th\\u0065me":2}', "duplicate JSON key at line 1"],
    [
      "duplicate in unknown array",
      '{"unknown":[{"key":1,"key":2}]}',
      "duplicate JSON key at line 1",
    ],
  ])("rejects %s without changing settings bytes", async (_name, original, reason) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "symnav-claude-invalid-"));
    directories.push(homeDirectory);
    const configuration = new ClaudeCodeSandboxConfiguration({ homeDirectory });
    await mkdir(join(homeDirectory, ".claude"));
    await writeFile(configuration.configurationPath, original);
    await expect(configuration.grant(join(homeDirectory, "state"))).rejects.toThrow(
      `cannot update ${configuration.configurationPath}: ${reason}`,
    );
    expect(await readFile(configuration.configurationPath, "utf8")).toBe(original);
  });
});
