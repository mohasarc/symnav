import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSymnavBinary } from "./run-symnav-binary.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const originalEnvironment = process.env;

describe("runSymnavBinary", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      PATH: "/test/bin",
      SYMNAV_TELEMETRY: "1",
    };

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as SpawnSyncReturns<string>);
  });

  afterEach(() => {
    process.env = originalEnvironment;
    vi.resetAllMocks();
  });

  it("runs the binary with telemetry off by default", () => {
    runSymnavBinary(["--version"], { cwd: "/fixture" });

    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({
      cwd: "/fixture",
      encoding: "utf8",
      env: {
        PATH: "/test/bin",
        SYMNAV_TELEMETRY: "0",
      },
    });
  });

  it("lets callers override the default environment", () => {
    runSymnavBinary(["overview", "src/index.ts"], {
      cwd: "/fixture",
      env: {
        SYMNAV_STATE_DIR: "/state",
        SYMNAV_TELEMETRY: "1",
      },
    });

    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({
      env: {
        PATH: "/test/bin",
        SYMNAV_STATE_DIR: "/state",
        SYMNAV_TELEMETRY: "1",
      },
    });
  });
});
