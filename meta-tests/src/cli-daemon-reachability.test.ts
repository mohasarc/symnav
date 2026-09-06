import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class TypeScriptImportSpecifierExtractor {
  private static readonly importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

  static extract(source: string): readonly string[] {
    return [...source.matchAll(TypeScriptImportSpecifierExtractor.importPattern)].map(
      (match) => (match[1] ?? match[2])!,
    );
  }
}

class TypeScriptProductionGraph {
  constructor(private readonly repositoryRoot: string) {}

  reachableFrom(entry: string): readonly string[] {
    const pending = [join(this.repositoryRoot, entry)];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const dependency of this.localDependencies(file)) {
        if (!visited.has(dependency)) pending.push(dependency);
      }
    }
    return [...visited].map((file) => relative(this.repositoryRoot, file)).sort();
  }

  private localDependencies(file: string): readonly string[] {
    const source = readFileSync(file, "utf8");
    return TypeScriptImportSpecifierExtractor.extract(source)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => this.resolveTypeScriptImport(file, specifier))
      .filter((dependency): dependency is string => dependency !== undefined);
  }

  private resolveTypeScriptImport(importer: string, specifier: string): string | undefined {
    const sourcePath = resolve(dirname(importer), specifier.replace(/\.js$/, ".ts"));
    if (existsSync(sourcePath)) return sourcePath;
    const indexPath = join(sourcePath, "index.ts");
    return existsSync(indexPath) ? indexPath : undefined;
  }
}

class DaemonPackageImportBoundary {
  static deepImports(source: string): readonly string[] {
    return TypeScriptImportSpecifierExtractor.extract(source).filter((specifier) =>
      specifier.startsWith("@symnav/daemon/"),
    );
  }
}

describe("CLI daemon production reachability", () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it("reaches no app-local daemon mechanism from the executable entry", () => {
    const reachable = new TypeScriptProductionGraph(repositoryRoot).reachableFrom(
      "apps/cli/src/cli.ts",
    );

    expect(reachable.filter((file) => file.startsWith("apps/cli/src/daemon/"))).toEqual([]);
    expect(reachable).toContain("apps/cli/src/cli-invocation-coordinator.ts");
    expect(reachable).toContain("apps/cli/src/commands/daemon/register-daemon-command.ts");
  });

  it("uses only the daemon package root throughout the reachable CLI graph", () => {
    const reachable = new TypeScriptProductionGraph(repositoryRoot).reachableFrom(
      "apps/cli/src/cli.ts",
    );
    const deepImports = reachable.flatMap((file) => {
      const source = readFileSync(join(repositoryRoot, file), "utf8");
      return DaemonPackageImportBoundary.deepImports(source).map(
        (specifier) => `${file}: ${specifier}`,
      );
    });

    expect(deepImports).toEqual([]);
  });

  it.each([
    ["static import from", 'import { DaemonClient } from "@symnav/daemon/client";'],
    ["side-effect import", 'import "@symnav/daemon/client";'],
    ["export from", 'export { DaemonClient } from "@symnav/daemon/client";'],
    ["dynamic literal import", 'await import("@symnav/daemon/client");'],
  ] as const)("rejects a deep daemon %s", (_form, source) => {
    expect(DaemonPackageImportBoundary.deepImports(source)).toEqual(["@symnav/daemon/client"]);
  });

  it.each([
    ["static import from", 'import { DaemonClient } from "@symnav/daemon";'],
    ["side-effect import", 'import "@symnav/daemon";'],
    ["export from", 'export { DaemonClient } from "@symnav/daemon";'],
    ["dynamic literal import", 'await import("@symnav/daemon");'],
  ] as const)("allows a daemon package-root %s", (_form, source) => {
    expect(DaemonPackageImportBoundary.deepImports(source)).toEqual([]);
  });
});
