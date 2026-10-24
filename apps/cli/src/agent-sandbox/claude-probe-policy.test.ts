import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeSandboxConfiguration } from "./claude-code-configuration.js";

class ProbePolicyScratch {
  public static readonly directories: string[] = [];
  public static async rootDenialHome(prefix: string): Promise<string> {
    const directory = process.platform === "win32" ? dirname(process.cwd()) : tmpdir();
    const home = await mkdtemp(join(directory, prefix));
    this.directories.push(home);
    return home;
  }
}
afterEach(async () => {
  await Promise.all(
    ProbePolicyScratch.directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
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
    ProbePolicyScratch.directories.push(home);
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
      filesystem: {
        allowWrite: ["/state"],
        denyWrite,
        denyRead,
        allowRead: ["/state/doctor/random/workspace"],
      },
    });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  },
);
it("rejects invalid deny nodes instead of dropping restrictions", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-probe-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  await writeFile(adapter.configurationPath, '{"sandbox":{"filesystem":{"denyWrite":"/state"}}}');
  await expect(adapter.inspect("/state", "/workspace")).rejects.toThrow(
    "denyWrite must be an array of strings",
  );
});
it("preserves original read carve-outs and adds only scratch workspace read access", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-read-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  const state = join(home, "state");
  const workspace = join(state, "doctor", "random", "workspace");
  await writeFile(
    adapter.configurationPath,
    JSON.stringify({
      sandbox: { filesystem: { allowWrite: [state], denyRead: [home], allowRead: [state] } },
    }),
  );
  const inspected = await adapter.inspect(state, workspace);
  expect(inspected.grantsState).toBe(true);
  expect(JSON.parse(inspected.configuration).filesystem).toEqual({
    allowWrite: [state],
    denyWrite: [],
    denyRead: [home],
    allowRead: [state, workspace],
  });
});
it("retains native Edit/Read denial paths instead of dropping permission restrictions", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-permission-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new ClaudeCodeSandboxConfiguration({
    homeDirectory: home,
    workspaceDirectory: join(home, "project"),
  });
  await mkdir(join(home, ".claude"));
  const state = join(home, "state");
  const original = JSON.stringify({
    permissions: { deny: [`Edit(/${state}/**)`, `Read(~/secret)`] },
    sandbox: { filesystem: { allowWrite: [state] } },
  });
  await writeFile(adapter.configurationPath, original);
  const inspected = await adapter.inspect(state, join(state, "workspace"));
  expect(inspected.grantsState).toBe(false);
  expect(JSON.parse(inspected.configuration).filesystem.denyRead).toContain(join(home, "secret"));
  expect(JSON.parse(inspected.configuration).filesystem.denyWrite).toEqual([state]);
  expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
});

it.each([false, true])(
  "retains a terminal Read denial with read carve-out %s",
  async (carveOut) => {
    const home = await mkdtemp(join(tmpdir(), "claude-permission-read-"));
    ProbePolicyScratch.directories.push(home);
    const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
    await mkdir(join(home, ".claude"));
    const state = join(home, "state");
    const workspace = join(state, "doctor", "random", "workspace");
    const allowRead = carveOut ? [state, join(home, "public")] : [];
    const original = JSON.stringify({
      permissions: { deny: [`Read(/${state}/**)`] },
      sandbox: { filesystem: { allowWrite: [state], allowRead } },
    });
    await writeFile(adapter.configurationPath, original);
    const inspected = await adapter.inspect(state, workspace);
    expect(inspected.grantsState).toBe(carveOut);
    expect(JSON.parse(inspected.configuration).filesystem).toEqual({
      allowWrite: [state],
      denyWrite: [],
      denyRead: [state],
      allowRead: [...allowRead, workspace],
    });
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  },
);

it.each([
  ["state", false],
  [join("state", "child"), false],
  ["state-sibling", true],
] as const)("preserves native subtree containment for %s", async (name, granted) => {
  const home = await mkdtemp(join(tmpdir(), "claude-permission-containment-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  const denied = join(home, "state");
  const state = join(home, name);
  await writeFile(
    adapter.configurationPath,
    JSON.stringify({
      permissions: { deny: [`Edit(/${denied}/**)`] },
      sandbox: { filesystem: { allowWrite: [home] } },
    }),
  );
  const inspected = await adapter.inspect(state, join(home, "workspace"));
  expect(inspected.grantsState).toBe(granted);
  expect(JSON.parse(inspected.configuration).filesystem.denyWrite).toEqual([denied]);
});

it.each([true, false])(
  "retains interior wildcard safeguards for a matching denial %s",
  async (matching) => {
    const home = await mkdtemp(join(tmpdir(), "claude-permission-pattern-"));
    ProbePolicyScratch.directories.push(home);
    const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
    await mkdir(join(home, ".claude"));
    const state = join(home, "private", "state");
    const denied = matching ? join(home, "*", "state") : join(home, "unrelated", "*", "state");
    const original = JSON.stringify({
      permissions: { deny: [`Edit(/${denied}/**)`] },
      sandbox: { filesystem: { allowWrite: [state] } },
    });
    await writeFile(adapter.configurationPath, original);
    const inspection = adapter.inspect(state, join(home, "workspace"));
    if (matching) {
      await expect(inspection).rejects.toThrow(
        "cannot verify a patterned state denial; use an absolute state policy",
      );
    } else {
      const inspected = await inspection;
      expect(inspected.grantsState).toBe(true);
      expect(JSON.parse(inspected.configuration).filesystem.denyWrite).toEqual([denied]);
    }
    expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
  },
);

it("checks grants and denies through canonical filesystem aliases", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-alias-"));
  ProbePolicyScratch.directories.push(home);
  const physical = join(home, "physical");
  const alias = join(home, "alias");
  await mkdir(physical);
  await symlink(physical, alias, "junction");
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  const source: { sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } } } = {
    sandbox: { filesystem: { allowWrite: [alias], denyWrite: [] as string[] } },
  };
  await writeFile(adapter.configurationPath, JSON.stringify(source));
  expect(
    (await adapter.inspect(join(physical, "state"), join(physical, "workspace"))).grantsState,
  ).toBe(true);
  source.sandbox.filesystem.denyWrite.push(join(alias, "state"));
  await writeFile(adapter.configurationPath, JSON.stringify(source));
  expect(
    (await adapter.inspect(join(physical, "state"), join(physical, "workspace"))).grantsState,
  ).toBe(false);
});
it.each(["denyRead", "denyWrite"])(
  "retains a global root subtree %s denial outside cwd",
  async (denial) => {
    const home = await ProbePolicyScratch.rootDenialHome("claude-root-denial-");
    const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
    await mkdir(join(home, ".claude"));
    const state = join(home, "state");
    const filesystem: Record<string, string[]> = { allowWrite: [state], [denial]: ["/**"] };
    await writeFile(adapter.configurationPath, JSON.stringify({ sandbox: { filesystem } }));
    expect((await adapter.inspect(state, join(state, "workspace"))).grantsState).toBe(false);
  },
);
it("keeps an original read carve-out beneath a root subtree denial", async () => {
  const home = await ProbePolicyScratch.rootDenialHome("claude-root-carveout-");
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  const state = join(home, "state");
  await writeFile(
    adapter.configurationPath,
    JSON.stringify({
      sandbox: { filesystem: { allowWrite: [state], denyRead: ["/**"], allowRead: [state] } },
    }),
  );
  expect((await adapter.inspect(state, join(state, "workspace"))).grantsState).toBe(true);
});
it("translates a native root subtree Edit denial to the filesystem root", async () => {
  const home = await ProbePolicyScratch.rootDenialHome("claude-native-root-");
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  const state = join(home, "state");
  await writeFile(
    adapter.configurationPath,
    JSON.stringify({
      permissions: { deny: ["Edit(//**)"] },
      sandbox: { filesystem: { allowWrite: [state] } },
    }),
  );
  const policy = await adapter.inspect(state, join(state, "workspace"));
  expect(policy.grantsState).toBe(false);
  expect(JSON.parse(policy.configuration).filesystem.denyWrite).toEqual(["/"]);
});

it("preserves the native absolute root when translating a root subtree permission", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-drive-root-"));
  ProbePolicyScratch.directories.push(home);
  const adapter = new ClaudeCodeSandboxConfiguration({ homeDirectory: home });
  await mkdir(join(home, ".claude"));
  const state = join(home, "state");
  const root = parse(state).root;
  const original = JSON.stringify({
    permissions: { deny: [`Edit(/${root}**)`] },
    sandbox: { filesystem: { allowWrite: [state] } },
  });
  await writeFile(adapter.configurationPath, original);
  const policy = await adapter.inspect(state, join(state, "workspace"));
  expect(policy.grantsState).toBe(false);
  expect(JSON.parse(policy.configuration).filesystem.denyWrite).toEqual([root]);
  expect(await readFile(adapter.configurationPath, "utf8")).toBe(original);
});
