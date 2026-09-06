import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

class TypeScriptImportSpecifierExtractor {
  static extract(source: string): readonly string[] {
    const sourceFile = ts.createSourceFile(
      "production.ts",
      source,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      const specifier = TypeScriptImportSpecifierExtractor.specifierOf(node);
      if (specifier !== undefined) specifiers.push(specifier);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specifiers;
  }

  private static specifierOf(node: ts.Node): string | undefined {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return TypeScriptImportSpecifierExtractor.literalText(node.moduleSpecifier);
    }
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      return undefined;
    }
    return TypeScriptImportSpecifierExtractor.literalText(node.arguments[0]);
  }

  private static literalText(node: ts.Node | undefined): string | undefined {
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
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

  it("traverses relative import-equals declarations", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "symnav-import-equals-"));
    try {
      writeFileSync(
        join(temporaryRoot, "entry.ts"),
        'import dependency = require("./dependency.js");',
      );
      writeFileSync(join(temporaryRoot, "dependency.ts"), "export const reachable = true;");

      expect(new TypeScriptProductionGraph(temporaryRoot).reachableFrom("entry.ts")).toEqual([
        "dependency.ts",
        "entry.ts",
      ]);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "static import from",
      'import { DaemonClient } from "@symnav/daemon/client";',
      "@symnav/daemon/client",
    ],
    ["side-effect import", 'import "@symnav/daemon/client";', "@symnav/daemon/client"],
    [
      "export from",
      'export { DaemonClient } from "@symnav/daemon/client";',
      "@symnav/daemon/client",
    ],
    ["dynamic literal import", 'await import("@symnav/daemon/client");', "@symnav/daemon/client"],
    [
      "spaced dynamic literal import",
      'await import /* load entry */ ("@symnav/daemon/process-entry");',
      "@symnav/daemon/process-entry",
    ],
    [
      "dynamic literal import with options",
      'await import("@symnav/daemon/process-entry", { with: { type: "json" } });',
      "@symnav/daemon/process-entry",
    ],
    [
      "import-equals declaration",
      'import entry = require("@symnav/daemon/process-entry");',
      "@symnav/daemon/process-entry",
    ],
    [
      "exported import-equals declaration",
      'export import entry = require("@symnav/daemon/process-entry");',
      "@symnav/daemon/process-entry",
    ],
  ] as const)("rejects a deep daemon %s", (_form, source, expectedSpecifier) => {
    expect(DaemonPackageImportBoundary.deepImports(source)).toEqual([expectedSpecifier]);
  });

  it.each([
    ["static import from", 'import { DaemonClient } from "@symnav/daemon";'],
    ["side-effect import", 'import "@symnav/daemon";'],
    ["export from", 'export { DaemonClient } from "@symnav/daemon";'],
    ["dynamic literal import", 'await import("@symnav/daemon");'],
    ["spaced dynamic literal import", 'await import /* load root */ ("@symnav/daemon");'],
    [
      "dynamic literal import with options",
      'await import("@symnav/daemon", { with: { type: "json" } });',
    ],
  ] as const)("allows a daemon package-root %s", (_form, source) => {
    expect(DaemonPackageImportBoundary.deepImports(source)).toEqual([]);
  });
});
