import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSymnavBinary } from "@symnav/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonTestingInstance } from "@symnav/daemon/testing";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";

describe("symnav daemon state location isolation", () => {
  const directories: string[] = [];
  const daemonProcessIds: number[] = [];

  afterEach(async () => {
    await E2eProcessCleanup.terminate(daemonProcessIds);
    daemonProcessIds.length = 0;
    E2eProcessCleanup.removeDirectories(directories);
    directories.length = 0;
  });

  it("isolates lifecycle and navigation for one workspace in two state directories", () => {
    const workspace = temporaryWorkspace(directories);
    const firstState = temporaryStateDirectory(directories);
    const secondState = temporaryStateDirectory(directories);

    expect(startDaemon(workspace, firstState).status).toBe(0);
    expect(startDaemon(workspace, secondState).status).toBe(0);
    const firstInstance = onlyInstance(firstState);
    const secondInstance = onlyInstance(secondState);
    daemonProcessIds.push(firstInstance.pid, secondInstance.pid);

    expect(firstInstance.pid).not.toBe(secondInstance.pid);
    expect(firstInstance.instanceId).not.toBe(secondInstance.instanceId);
    expect(statusProcessIds(firstState)).toEqual([firstInstance.pid]);
    expect(statusProcessIds(secondState)).toEqual([secondInstance.pid]);
    expect(overview(workspace, firstState)).toMatchObject({ status: 0, stderr: "" });
    expect(overview(workspace, secondState)).toMatchObject({ status: 0, stderr: "" });

    const stopped = runSymnavBinary(["daemon", "stop", "--json"], {
      cwd: workspace,
      env: { SYMNAV_STATE_DIR: firstState },
    });

    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      status: "stopped",
      pid: firstInstance.pid,
    });
    expect(statusProcessIds(firstState)).toEqual([]);
    expect(statusProcessIds(secondState)).toEqual([secondInstance.pid]);
    expect(overview(workspace, secondState)).toMatchObject({ status: 0, stderr: "" });
  });

  it("converges lifecycle and navigation through equivalent state directory spellings", () => {
    const workspace = temporaryWorkspace(directories);
    const stateDirectory = temporaryStateDirectory(directories);
    const linkDirectory = temporaryStateDirectory(directories);
    const stateLink = join(linkDirectory, "state-link");
    symlinkSync(stateDirectory, stateLink, process.platform === "win32" ? "junction" : "dir");
    const dottedLink = `${stateLink}/.`;
    const canonicalStateDirectory = realpathSync(stateDirectory);

    expect(startDaemon(workspace, dottedLink).status).toBe(0);
    const instance = onlyInstance(canonicalStateDirectory);
    daemonProcessIds.push(instance.pid);

    expect(startDaemon(workspace, canonicalStateDirectory).status).toBe(0);
    expect(onlyInstance(stateLink)).toMatchObject({
      pid: instance.pid,
      instanceId: instance.instanceId,
    });
    expect(statusProcessIds(dottedLink)).toEqual([instance.pid]);
    expect(statusProcessIds(canonicalStateDirectory)).toEqual([instance.pid]);
    expect(overview(workspace, stateLink)).toMatchObject({ status: 0, stderr: "" });

    const stopped = runSymnavBinary(["daemon", "stop", "--json"], {
      cwd: workspace,
      env: { SYMNAV_STATE_DIR: canonicalStateDirectory },
    });
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ status: "stopped", pid: instance.pid });
    expect(statusProcessIds(stateLink)).toEqual([]);
  });
});

function temporaryStateDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-state-isolation-"));
  directories.push(directory);
  return directory;
}

function temporaryWorkspace(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-state-isolation-workspace-"));
  directories.push(directory);
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, "input.ts"), "export const value = 1;\n");
  return directory;
}

function startDaemon(workspace: string, stateDirectory: string) {
  return runSymnavBinary(["daemon", "start"], {
    cwd: workspace,
    env: { SYMNAV_STATE_DIR: stateDirectory },
  });
}

function onlyInstance(stateDirectory: string): DaemonTestingInstance {
  const instances = new CliDaemonTesting(stateDirectory).inspector.listInstances();
  if (instances.length !== 1)
    throw new Error(`Expected one daemon instance, received ${instances.length}`);
  return instances[0]!;
}

function statusProcessIds(stateDirectory: string): readonly number[] {
  const result = runSymnavBinary(["daemon", "status", "--json"], {
    cwd: tmpdir(),
    env: { SYMNAV_STATE_DIR: stateDirectory },
  });
  expect(result.status).toBe(0);
  return (
    JSON.parse(result.stdout) as { readonly daemons: readonly { readonly pid: number }[] }
  ).daemons.map((entry) => entry.pid);
}

function overview(workspace: string, stateDirectory: string) {
  const result = runSymnavBinary(["overview", "input.ts"], {
    cwd: workspace,
    env: { SYMNAV_STATE_DIR: stateDirectory },
  });
  expect(result.stdout).toContain("Overview: input.ts");
  expect(result.stdout).toContain("value");
  return result;
}
