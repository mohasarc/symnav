import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("LocalDaemonTransport", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("listens on a daemon endpoint until closed", async () => {
    const endpoint = endpointFor(roots);
    const server = await new LocalDaemonTransport().listen(endpoint, async () => ({
      kind: "stopped",
      instanceId: "instance",
    }));

    await expect(server.close()).resolves.toBeUndefined();
  });
});

function endpointFor(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-transport-"));
  roots.push(root);
  return process.platform === "win32" ? `\\\\.\\pipe\\symnav-${Date.now()}` : join(root, "d.sock");
}
