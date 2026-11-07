import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "../../src/daemon-policy.js";
import {
  DaemonProcessConfigurationParser,
  NodeDaemonProcessLauncher,
} from "../../dist/process/process-launcher.js";
import { DaemonWorkspaceIdentity } from "../../dist/registry/workspace-identity.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

describe("built daemon process launcher", () => {
  const roots: string[] = [];

  afterEach(() => {
    spawnMock.mockReset();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it.each([
    ["POSIX", pathToFileURL("/tmp/symnav executor.mjs").href],
    ["Windows", "file:///C:/symnav/executor-module.mjs"],
  ])("spawns the injected entry and retains the %s executor URL", async (_form, moduleUrl) => {
    spawnMock.mockImplementation(() => {
      const child: {
        readonly pid: number;
        readonly once: ReturnType<typeof vi.fn>;
        readonly unref: ReturnType<typeof vi.fn>;
      } = {
        pid: 4321,
        once: vi.fn((event: string, listener: () => void) => {
          if (event === "spawn") queueMicrotask(listener);
          return child;
        }),
        unref: vi.fn(),
      };
      return child;
    });
    const root = mkdtempSync(join(tmpdir(), "symnav-built-launcher-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from(join(root, "workspace"), join(root, "state"));
    mkdirSync(identity.identityDirectory, { recursive: true });
    const processEntryUrl = pathToFileURL(join(root, "bundle", "process-entry.js")).href;

    await new NodeDaemonProcessLauncher(
      "1.2.3",
      moduleUrl,
      processEntryUrl,
      DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 }),
    ).launch(identity, "instance", "process-token");

    const [executable, arguments_] = spawnMock.mock.calls[0] as [string, readonly string[]];
    expect(executable).toBe(process.execPath);
    expect(arguments_[0]).toBe(fileURLToPath(processEntryUrl));
    expect(DaemonProcessConfigurationParser.parse(arguments_[1]).executorModuleUrl).toBe(moduleUrl);
  });
});
