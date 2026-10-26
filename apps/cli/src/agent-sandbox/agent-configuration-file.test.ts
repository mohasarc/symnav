import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigurationFile } from "./agent-configuration-file.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe("AgentConfigurationFile", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => filesystem.rm(directory, { recursive: true, force: true })),
    );
  });

  it("preserves existing mode through atomic replacement", async () => {
    const directory = await filesystem.mkdtemp(join(tmpdir(), "symnav-config-mode-"));
    directories.push(directory);
    const path = join(directory, "config.toml");
    await filesystem.writeFile(path, "original", { mode: 0o640 });
    await new AgentConfigurationFile(path).publish("original", "updated");
    expect(await filesystem.readFile(path, "utf8")).toBe("updated");
    if (process.platform !== "win32")
      expect((await filesystem.stat(path)).mode & 0o777).toBe(0o640);
    expect(await filesystem.readdir(directory)).toEqual(["config.toml"]);
  });

  it("leaves original bytes and mode intact after atomic publication fails", async () => {
    const directory = await filesystem.mkdtemp(join(tmpdir(), "symnav-config-failure-"));
    directories.push(directory);
    const path = join(directory, "config.toml");
    await filesystem.writeFile(path, "original", { mode: 0o640 });
    vi.spyOn(filesystem, "rename").mockRejectedValueOnce(
      Object.assign(new Error("rename denied"), { code: "EACCES" }),
    );
    await expect(new AgentConfigurationFile(path).publish("original", "updated")).rejects.toThrow(
      "rename denied",
    );
    expect(await filesystem.readFile(path, "utf8")).toBe("original");
    expect(await filesystem.readdir(directory)).toEqual(["config.toml"]);
    if (process.platform !== "win32")
      expect((await filesystem.stat(path)).mode & 0o777).toBe(0o640);
  });

  it("refuses a concurrent change without overwriting it", async () => {
    const directory = await filesystem.mkdtemp(join(tmpdir(), "symnav-config-concurrent-"));
    directories.push(directory);
    const path = join(directory, "config.toml");
    await filesystem.writeFile(path, "concurrent");
    await expect(new AgentConfigurationFile(path).publish("original", "updated")).rejects.toThrow(
      "configuration changed during setup",
    );
    expect(await filesystem.readFile(path, "utf8")).toBe("concurrent");
    expect(await filesystem.readdir(directory)).toEqual(["config.toml"]);
  });

  it("creates a private configuration file", async () => {
    const directory = await filesystem.mkdtemp(join(tmpdir(), "symnav-config-private-"));
    directories.push(directory);
    const path = join(directory, "nested", "config.toml");
    await new AgentConfigurationFile(path).publish("", "created");
    if (process.platform !== "win32")
      expect((await filesystem.stat(path)).mode & 0o777).toBe(0o600);
  });
});
