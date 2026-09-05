import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class DaemonCompatibilityCopyInventory {
  static readonly expectedDigest = "d0ff136f3be132ea004d3b13985192e055d1dfbad1abb773b607e89c54a1f41e";

  static files(repositoryRoot: string): readonly string[] {
    const daemonDirectory = join(repositoryRoot, "apps/cli/src/daemon");
    const cliOwnedSources = new Set([
      "daemon-command-dispatcher.ts",
      "invocation-route.ts",
      "invocation-workspace-selector.ts",
    ]);
    return readdirSync(daemonDirectory)
      .filter(
        (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !cliOwnedSources.has(name),
      )
      .map((name) => `apps/cli/src/daemon/${name}`)
      .sort();
  }

  static digest(repositoryRoot: string, files: readonly string[]): string {
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(join(repositoryRoot, file)));
      hash.update("\0");
    }
    return hash.digest("hex");
  }
}

describe("CLI daemon compatibility copies", () => {
  it("remain frozen while package-local mechanisms are staged", () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const files = DaemonCompatibilityCopyInventory.files(repositoryRoot);

    expect(files).toHaveLength(38);
    expect(DaemonCompatibilityCopyInventory.digest(repositoryRoot, files)).toBe(
      DaemonCompatibilityCopyInventory.expectedDigest,
    );
  });
});
