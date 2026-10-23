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
