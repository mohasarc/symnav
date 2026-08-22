import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";

describe("LocalDaemonTransport", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });
});

function endpointFor(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-transport-"));
  roots.push(root);
  return process.platform === "win32" ? `\\\\.\\pipe\\symnav-${Date.now()}` : join(root, "d.sock");
}
