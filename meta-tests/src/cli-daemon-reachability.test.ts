import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class TypeScriptProductionGraph {
  private static readonly importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

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
    return [...source.matchAll(TypeScriptProductionGraph.importPattern)]
      .map((match) => match[1] ?? match[2])
      .filter((specifier): specifier is string => specifier?.startsWith(".") === true)
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
      return [...source.matchAll(/from\s+["'](@symnav\/daemon\/[^"']+)["']/g)].map(
        (match) => `${file}: ${match[1]}`,
      );
    });

    expect(deepImports).toEqual([]);
  });
});
