import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveStateDir, usageLogPath } from "@symnav/telemetry";
import type { ProgramDependencies } from "./program-dependencies.js";
import { createDefaultDependencies } from "./program.js";

const temporaryDirectories: string[] = [];
const originalStateDirectory = process.env.SYMNAV_STATE_DIR;

afterEach(() => {
  if (originalStateDirectory === undefined) delete process.env.SYMNAV_STATE_DIR;
  else process.env.SYMNAV_STATE_DIR = originalStateDirectory;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps telemetry recorder and machine identity on the captured state directory", () => {
  const root = mkdtempSync(join(tmpdir(), "symnav-program-state-"));
  temporaryDirectories.push(root);
  const firstStateDirectory = join(root, "first");
  const secondStateDirectory = join(root, "second");
  const configuredStateDirectory = join(root, "configured");
  mkdirSync(firstStateDirectory);
  mkdirSync(secondStateDirectory);
  symlinkSync(
    firstStateDirectory,
    configuredStateDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  process.env.SYMNAV_STATE_DIR = configuredStateDirectory;
  const capturedStateDirectory = resolveStateDir(process.env);
  rmSync(configuredStateDirectory);
  symlinkSync(
    secondStateDirectory,
    configuredStateDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  const dependencies = Reflect.apply(createDefaultDependencies, undefined, [
    capturedStateDirectory,
  ]) as ProgramDependencies;
  const identity = dependencies.identity.resolve({ cwd: root, workspaceRoot: undefined });
  dependencies.recorder.record({
    symnavVersion: dependencies.symnavVersion,
    command: "overview",
    timestamp: 1,
    durationMs: 1,
    executionMode: "cold",
    outcome: "success",
    argShape: { kind: "path", lengthBucket: "short", flags: [] },
    workspaceId: identity.workspaceId,
    machineId: identity.machineId,
  });

  expect(readFileSync(join(firstStateDirectory, "machine-id"), "utf8")).toBe(identity.machineId);
  expect(readFileSync(usageLogPath(firstStateDirectory), "utf8")).toContain(identity.machineId);
  expect(existsSync(join(secondStateDirectory, "machine-id"))).toBe(false);
  expect(existsSync(usageLogPath(secondStateDirectory))).toBe(false);
});
