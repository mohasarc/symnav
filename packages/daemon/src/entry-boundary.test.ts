import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

class EntryExportInventory {
  static namedExports(path: string): readonly string[] {
    const source = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return sourceFile.statements.flatMap((statement) =>
      EntryExportInventory.exportsName(statement) ? [statement.getText(sourceFile)] : [],
    );
  }

  private static exportsName(statement: ts.Statement): boolean {
    if (ts.isExportAssignment(statement) || ts.isNamespaceExportDeclaration(statement)) return true;
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) {
        return true;
      }
      return statement.exportClause.elements.length > 0;
    }
    return (
      ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword,
        ) ??
        false)
    );
  }
}

describe("daemon executable entry boundary", () => {
  it.each(["process-entry", "worker-entry"])(
    "keeps %s source and declarations side-effect-only",
    (entry) => {
      const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

      expect(
        EntryExportInventory.namedExports(join(packageDirectory, "src", `${entry}.ts`)),
      ).toEqual([]);
      expect(
        EntryExportInventory.namedExports(join(packageDirectory, "dist", `${entry}.d.ts`)),
      ).toEqual([]);
    },
  );
});
