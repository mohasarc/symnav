import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class RendererPackageMetadata {
  private static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  private static readonly packageRoot = join(RendererPackageMetadata.repoRoot, "packages/renderer");

  static productionInternalDependencies(): readonly string[] {
    const manifest = JSON.parse(
      readFileSync(join(RendererPackageMetadata.packageRoot, "package.json"), "utf8"),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    return Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith("@symnav/"))
      .sort();
  }

  static daemonImports(): readonly string[] {
    return RendererPackageMetadata.files(join(RendererPackageMetadata.packageRoot, "src"))
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [...source.matchAll(/from [\"'](@symnav\/daemon[^\\\"']*)[\"']/g)].map(
          (match) => match[1]!,
        );
      });
  }

  private static files(directory: string): readonly string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? RendererPackageMetadata.files(path) : [path];
    });
  }
}

describe("@symnav/renderer package boundary", () => {
  it("depends publicly on only core and daemon", () => {
    expect(RendererPackageMetadata.productionInternalDependencies()).toEqual([
      "@symnav/core",
      "@symnav/daemon",
    ]);
  });

  it("imports daemon reports only through the public package root", () => {
    expect(RendererPackageMetadata.daemonImports()).toEqual(["@symnav/daemon"]);
  });
});
