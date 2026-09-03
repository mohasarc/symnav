import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface DaemonPackageManifest {
  readonly name: string;
  readonly private: boolean;
  readonly type: string;
  readonly main: string;
  readonly types: string;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, unknown>>;
  readonly bundledDependencies?: readonly string[];
  readonly bundleDependencies?: readonly string[];
}

class DaemonPackageMetadata {
  public static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  public static readonly packageRoot = join(DaemonPackageMetadata.repoRoot, "packages/daemon");

  public static manifest(): DaemonPackageManifest {
    return JSON.parse(
      readFileSync(join(DaemonPackageMetadata.packageRoot, "package.json"), "utf8"),
    ) as DaemonPackageManifest;
  }

  public static productionDependencyNames(manifest: DaemonPackageManifest): readonly string[] {
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.peerDependenciesMeta ?? {}),
      ...(manifest.bundledDependencies ?? []),
      ...(manifest.bundleDependencies ?? []),
    ].sort();
  }
}

describe("@symnav/daemon package boundary", () => {
  it("has the exact private ESM root and temporary policy-testing exports", () => {
    const manifest = DaemonPackageMetadata.manifest();
    expect({
      name: manifest.name,
      private: manifest.private,
      type: manifest.type,
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports,
    }).toEqual({
      name: "@symnav/daemon",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        "./policy-testing": {
          types: "./dist/policy-testing.d.ts",
          default: "./dist/policy-testing.js",
        },
      },
    });
    expect(Object.keys(manifest.exports)).toEqual([".", "./policy-testing"]);
  });

  it("has zero internal packages in every production dependency field", () => {
    const names = DaemonPackageMetadata.productionDependencyNames(DaemonPackageMetadata.manifest());
    expect(names.filter((name) => name.startsWith("@symnav/"))).toEqual([]);
  });

  it("proves every supported production dependency field is inspected", () => {
    const manifest: DaemonPackageManifest = {
      name: "fixture",
      private: true,
      type: "module",
      main: "index.js",
      types: "index.d.ts",
      exports: {},
      dependencies: { "@symnav/dependency": "workspace:*" },
      optionalDependencies: { "@symnav/optional": "workspace:*" },
      peerDependencies: { "@symnav/peer": "workspace:*" },
      peerDependenciesMeta: { "@symnav/peer-meta": {} },
      bundledDependencies: ["@symnav/bundled"],
      bundleDependencies: ["@symnav/bundle"],
    };
    expect(DaemonPackageMetadata.productionDependencyNames(manifest)).toEqual([
      "@symnav/bundle",
      "@symnav/bundled",
      "@symnav/dependency",
      "@symnav/optional",
      "@symnav/peer",
      "@symnav/peer-meta",
    ]);
  });
});
