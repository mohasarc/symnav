import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ControlledLifecycleDaemon } from "./controlled-lifecycle-daemon.js";
import { E2eProcessCleanup } from "./e2e-process-cleanup.js";

it("rejects a preload exit before controlled startup failure enters the actor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "symnav-controlled-preload-"));
  let daemon: ControlledLifecycleDaemon | undefined;
  try {
    vi.stubEnv("NODE_OPTIONS", "--require=symnav-controlled-preload-does-not-exist");
    const started = ControlledLifecycleDaemon.start(directory, directory, "startup-failure");
    await expect(
      started.then((startedDaemon) => {
        daemon = startedDaemon;
      }),
    ).rejects.toThrow(
      /Controlled lifecycle actor exited before startup.*exit code 1.*symnav-controlled-preload-does-not-exist/s,
    );
  } finally {
    vi.unstubAllEnvs();
    await daemon?.dispose();
    E2eProcessCleanup.removeDirectories([directory]);
  }
});

it("observes buffered stderr and actual close without waiting or signalling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "symnav-controlled-observation-"));
  let daemon: ControlledLifecycleDaemon | undefined;
  try {
    daemon = await ControlledLifecycleDaemon.start(directory, directory);
    const token = daemon.actor.spawnargs.find((argument) => argument.endsWith("-token"))!;
    daemon.actor.stderr!.emit("data", `actor failure ${token}`);
    const kill = vi.spyOn(daemon.actor, "kill");
    const pending = daemon.diagnosticSnapshot();
    expect(pending).toEqual({
      pid: daemon.actor.pid,
      stderr: "actor failure [redacted]",
      exitCode: null,
      signalCode: null,
      close: { state: "pending" },
    });
    expect(kill).not.toHaveBeenCalled();
    await daemon.dispose();
    await daemon.exited;
    const closed = daemon.diagnosticSnapshot();
    expect(closed.close).toEqual({
      state: "closed",
      status: daemon.actor.exitCode,
      signal: daemon.actor.signalCode,
    });
    expect(closed.stderr).not.toContain(token);
    expect(pending.close).toEqual({ state: "pending" });
  } finally {
    await daemon?.dispose();
    E2eProcessCleanup.removeDirectories([directory]);
  }
});
