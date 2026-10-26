import { spawn, spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  mkdtempSync,
  readdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PosixDaemonProcessLifetime } from "./posix-process-lifetime.js";

class LifetimeFixture {
  public readonly state = mkdtempSync(join(tmpdir(), "symnav lifetime 日本語-"));
  public dispose(): void {
    rmSync(this.state, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("POSIX daemon process lifetime", () => {
  const fixtures: LifetimeFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.dispose();
  });
  const fixture = (): LifetimeFixture => {
    const result = new LifetimeFixture();
    fixtures.push(result);
    return result;
  };

  it("retains current authority independently of endpoint cleanup", () => {
    const state = fixture().state;
    const identity = PosixDaemonProcessLifetime.current(state);
    expect(PosixDaemonProcessLifetime.current(state)).toEqual(identity);
    expect(PosixDaemonProcessLifetime.observe(identity)).toBe("live");
    expect(PosixDaemonProcessLifetime.observe({ ...identity, token: "wrong" })).toBe("unknown");
    expect(PosixDaemonProcessLifetime.observe({ ...identity, path: join(state, "missing") })).toBe(
      "unknown",
    );
  });

  it("proves exit only after the last inherited reader exits", async () => {
    const prepared = PosixDaemonProcessLifetime.prepareChild(fixture().state);
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('fs').fstatSync(3).isFIFO() || process.exit(2); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore", prepared.descriptor] },
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      prepared.closeParentCopy();
      prepared.closeParentCopy();
      for (let index = 0; index < 100; index += 1)
        expect(PosixDaemonProcessLifetime.observe(prepared.identity)).toBe("live");
      child.kill("SIGKILL");
      await exited;
      expect(PosixDaemonProcessLifetime.observe(prepared.identity)).toBe("exited");
    } finally {
      prepared.closeParentCopy();
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("does not let a writer probe prolong lifetime", () => {
    const prepared = PosixDaemonProcessLifetime.prepareChild(fixture().state);
    const writer = openSync(prepared.identity.path, constants.O_WRONLY | constants.O_NONBLOCK);
    prepared.closeParentCopy();
    try {
      expect(PosixDaemonProcessLifetime.observe(prepared.identity)).toBe("exited");
    } finally {
      closeSync(writer);
    }
  });

  it("retains unknown files, symlinks and missing sentinels", () => {
    const prepared = PosixDaemonProcessLifetime.prepareChild(fixture().state);
    prepared.closeParentCopy();
    rmSync(prepared.identity.path);
    expect(PosixDaemonProcessLifetime.observe(prepared.identity)).toBe("unknown");
    writeFileSync(prepared.identity.path, "ordinary file");
    expect(PosixDaemonProcessLifetime.observe(prepared.identity)).toBe("unknown");
    rmSync(prepared.identity.path);
    const other = PosixDaemonProcessLifetime.prepareChild(fixture().state);
    symlinkSync(other.identity.path, prepared.identity.path);
    expect(PosixDaemonProcessLifetime.observe(prepared.identity)).toBe("unknown");
    other.closeParentCopy();
  });

  it("rejects a symlinked lifetime directory before creating outside state", () => {
    const state = fixture().state;
    const outside = fixture().state;
    symlinkSync(outside, join(state, "process-lifetimes"));
    expect(() => PosixDaemonProcessLifetime.prepareChild(state)).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("reports a missing utility without inventing an OS code for utility exit", () => {
    const original = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => PosixDaemonProcessLifetime.prepareChild(fixture().state)).toThrow(
        expect.objectContaining({ name: "DaemonProcessLifetimeCreationError", code: "ENOENT" }),
      );
    } finally {
      process.env.PATH = original;
    }
    expect(
      spawnSync("mkfifo", ["-m", "600", join(fixture().state, "missing", "fifo")]).status,
    ).not.toBe(0);
  });
});
