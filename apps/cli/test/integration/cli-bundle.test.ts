import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliBundle } from "../../scripts/cli-bundle.js";

const BUNDLE_TIMEOUT_MS = 120_000;

class BundledPackage {
  static nameOf(specifier: string): string {
    const segments = specifier.split("/");
    return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
  }
}

describe("CliBundle", () => {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const outDirectory = mkdtempSync(join(tmpdir(), "symnav-cli-bundle-"));
  let externalImports: ReadonlySet<string> = new Set();

  beforeAll(async () => {
    ({ externalImports } = await new CliBundle({ outDirectory, packageRoot }).build());
  }, BUNDLE_TIMEOUT_MS);

  afterAll(() => {
    rmSync(outDirectory, { recursive: true, force: true });
  });

  it("emits one file per entry", () => {
    expect(
      readdirSync(outDirectory)
        .filter((name) => name.endsWith(".js"))
        .sort(),
    ).toEqual([
      "cli.js",
      "daemon-executor.js",
      "process-entry.js",
      "sandbox-probe-entry.js",
      "worker-entry.js",
    ]);
  });

  it("inlines every @symnav package", () => {
    const symnavImport = /(?:from|import)\s*\(?\s*["']@symnav\//;
    for (const name of readdirSync(outDirectory).filter((file) => file.endsWith(".js"))) {
      expect(readFileSync(join(outDirectory, name), "utf8")).not.toMatch(symnavImport);
    }
    expect([...externalImports].filter((specifier) => specifier.startsWith("@symnav/"))).toEqual(
      [],
    );
  });

  it("leaves only declared dependencies external", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const externalPackages = [...externalImports]
      .filter((specifier) => !isBuiltin(specifier))
      .map((specifier) => BundledPackage.nameOf(specifier));

    expect(externalPackages.length).toBeGreaterThan(0);
    for (const name of externalPackages) expect(Object.keys(manifest.dependencies)).toContain(name);
  });

  it("starts cli.js with a node shebang", () => {
    expect(readFileSync(join(outDirectory, "cli.js"), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
  });
});
