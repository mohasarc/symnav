import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeSandboxConfiguration } from "./claude-code-configuration.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
it.each([
  [true, [], [], true],
  [true, ["/state"], [], false],
  [true, [], ["/state/sub"], false],
  [false, [], [], true],
] as const)(
  "inspects Claude effective grants and isolates runtime policy: enabled %s denies %s %s",
  async (enabled, denyWrite, denyRead, granted) => {
    const home = await mkdtemp(join(tmpdir(), "claude-probe-"));
    directories.push(home);
    const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
    await mkdir(join(home, ".claude"));
    const original = JSON.stringify({
      hooks: { private: "credentials" },
      sandbox: {
        enabled,
        network: { allowedDomains: ["example.com"] },
        filesystem: { allowWrite: ["/state"], denyWrite, denyRead },
      },
    });
    await writeFile(adapter.configurationPath, original);
    const result = await adapter.inspect("/state/sub", "/state/doctor/random/workspace");
    expect(result.grantsState).toBe(granted);
    expect(JSON.parse(result.configuration)).toEqual({
      network: { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: { allowWrite: ["/state"], denyWrite, denyRead },
    });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  },
);
it("rejects invalid deny nodes instead of dropping restrictions", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-probe-"));
  directories.push(home);
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  await writeFile(adapter.configurationPath, '{"sandbox":{"filesystem":{"denyWrite":"/state"}}}');
  await expect(adapter.inspect("/state", "/workspace")).rejects.toThrow(
    "denyWrite must be an array of strings",
  );
});
