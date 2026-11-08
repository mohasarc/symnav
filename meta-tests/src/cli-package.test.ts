import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface CliPackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
}

class CliPackage {
  private static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  static manifest(): CliPackageManifest {
    return JSON.parse(
      readFileSync(join(CliPackage.repoRoot, "apps/cli/package.json"), "utf8"),
    ) as CliPackageManifest;
  }
}

describe("symnav package", () => {
  it("ships only the bundled symnav bin", () => {
    const manifest = CliPackage.manifest();

    expect(manifest.bin).toEqual({ symnav: "./dist/cli.js" });
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
    expect(manifest).not.toHaveProperty("exports");
  });

  it("is publishable", () => {
    expect(CliPackage.manifest()).not.toHaveProperty("private");
  });
});
