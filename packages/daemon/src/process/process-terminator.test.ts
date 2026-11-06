import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import { NodeDaemonProcessTerminator } from "./process-launcher.js";
import { PosixDaemonProcessLifetime } from "./posix-process-lifetime.js";
import type { DaemonProcessLifetimeIdentity } from "./process-lifetime-identity.js";

describe("NodeDaemonProcessTerminator", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the host's legacy exit evidence for a reaped process", () => {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const terminator = new NodeDaemonProcessTerminator(
      DaemonPolicy.currentSystem().values.shutdown,
    );

    expect(terminator.hasExited(child.pid)).toBe(
      process.platform === "darwin" || process.platform === "win32",
    );
  });

  it("retains a live legacy process without lifetime metadata", () => {
    const terminator = new NodeDaemonProcessTerminator(
      DaemonPolicy.currentSystem().values.shutdown,
    );

    expect(terminator.hasExited(process.pid)).toBe(false);
  });

  describe.skipIf(process.platform === "win32")("POSIX exit evidence", () => {
    it.each(["EPERM", "EACCES", "EIO"])(
      "does not classify an inconclusive %s legacy probe as process exit",
      (code) => {
        const probe = vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("probe unavailable"), { code });
        });
        const terminator = new NodeDaemonProcessTerminator(
          DaemonPolicy.currentSystem().values.shutdown,
        );

        expect(terminator.hasExited(12345)).toBe(false);
        if (process.platform === "darwin") expect(probe).toHaveBeenCalledWith(12345, 0);
        else expect(probe).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["live", false],
      ["unknown", false],
      ["exited", true],
    ] as const)("keeps %s lifetime evidence independent of PID probes", (observation, exited) => {
      const token = "12345678-1234-1234-1234-123456789abc";
      const lifetime: DaemonProcessLifetimeIdentity = {
        token,
        path: join(tmpdir(), "process-lifetimes", `${token}.fifo`),
      };
      const observe = vi.spyOn(PosixDaemonProcessLifetime, "observe").mockReturnValue(observation);
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("PID no longer exists"), { code: "ESRCH" });
      });
      const terminator = new NodeDaemonProcessTerminator(
        DaemonPolicy.currentSystem().values.shutdown,
      );

      expect(terminator.hasExited(12345, lifetime)).toBe(exited);
      expect(observe).toHaveBeenCalledWith(lifetime);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
