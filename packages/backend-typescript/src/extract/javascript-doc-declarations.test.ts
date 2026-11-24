import { describe, expect, it } from "vitest";
import { Project, ts, type SourceFile } from "ts-morph";
import { OverviewTree, formatSymbolIdentity, type SymbolOverviewNode } from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractFileEntries } from "./extract-file-entries.js";
import { FileDeclarationExtraction } from "./file-declaration-extraction.js";

describe("JSDoc type alias declarations in overview", () => {
  it("lists @typedef and @callback tags before a statement as type aliases spanning their tag lines", () => {
    const source = [
      "exports.q = 1;",
      "/**",
      " * @typedef {Object} Shape",
      " * @property {number} width",
      " */",
      "/**",
      " * @callback Visit",
      " * @param {Shape} shape",
      " */",
      "function walk() {}",
    ].join("\n");

    expect(summariesOf(source)).toEqual([
      { id: "input.js::q", label: "variable", range: [1, 1], header: ["exports.q = 1"] },
      {
        id: "input.js::Shape",
        label: "type-alias",
        range: [3, 4],
        header: ["@typedef {Object} Shape"],
      },
      { id: "input.js::Visit", label: "type-alias", range: [7, 8], header: ["@callback Visit"] },
      {
        id: "input.js::walk",
        label: "function-implementation",
        range: [10, 10],
        header: ["function walk()"],
      },
    ]);
  });

  it("lists each type alias tag of one comment", () => {
    const source = ["/**", " * @typedef {string} A", " * @typedef {number} B", " */", "f();"].join(
      "\n",
    );

    expect(summariesOf(source)).toEqual([
      { id: "input.js::A", label: "type-alias", range: [2, 2], header: ["@typedef {string} A"] },
      { id: "input.js::B", label: "type-alias", range: [3, 3], header: ["@typedef {number} B"] },
    ]);
  });

  it("lists type alias tags at the end of the file and in a file without statements", () => {
    expect(idsOf("export const x = 1;\n/** @typedef {string} Tail */\n")).toEqual([
      "input.js::x",
      "input.js::Tail",
    ]);
    expect(idsOf("/** @callback Only */\n")).toEqual(["input.js::Only"]);
  });

  it("nests type alias tags of statements in a function body or block under their scope", () => {
    const source = [
      "function outer() {",
      "  /** @typedef {string} Inner */",
      "  const local = 1;",
      "  if (local) {",
      "    /** @typedef {number} InBlock */",
      "    run();",
      "  }",
      "}",
      "var later = () => {",
      "  /** @callback InArrow */",
      "  return 1;",
      "};",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::outer",
      "input.js::outer::Inner",
      "input.js::outer::local",
      "input.js::outer::InBlock",
      "input.js::later",
      "input.js::later::InArrow",
    ]);
  });

  it("emits no node for nameless or dotted type alias tags", () => {
    const source = [
      "/** @typedef {string} */",
      "var Alias;",
      "/** @typedef {string} ns.Dotted */",
      "var ns = {};",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::Alias", "input.js::ns"]);
  });

  it("emits no node for the same syntax in a TypeScript file", () => {
    expect(idsOf("/** @typedef {string} A */\nexport const x = 1;\n", "input.ts")).toEqual([
      "input.ts::x",
    ]);
  });
});

describe("JSDoc type alias declarations against the TypeScript binder", () => {
  it.each([
    [
      "CommonJS module scope",
      "input.js",
      [
        "/** @typedef {string} Before */",
        "exports.q = 1;",
        "/**",
        " * @typedef {Object} Shape",
        " * @property {number} width",
        " * @callback Visit",
        " * @param {Shape} shape",
        " */",
        "function walk() {}",
        "/** @typedef {string} Twice */",
        "/** @typedef {number} Twice */",
        "if (ready) {",
        "  /** @typedef {string} InIf */",
        "  run();",
        "}",
        "/** @typedef {string} OnFor */",
        "for (;;) {}",
        "/** @typedef {string} AtEnd */",
      ],
    ],
    [
      "nested scopes",
      "input.js",
      [
        "exports.q = 1;",
        "function outer() {",
        "  /** @typedef {string} Inner */",
        "  const local = () => {",
        "    /** @callback InArrow */",
        "    return 1;",
        "  };",
        "  switch (local) {",
        "    case 1:",
        "      /** @typedef {string} InCase */",
        "      break;",
        "  }",
        "  try {",
        "    /** @typedef {string} InTry */",
        "    run();",
        "  } catch (error) {",
        "    /** @typedef {string} InCatch */",
        "    run();",
        "  }",
        "}",
        "exports.make = function () {",
        "  /** @typedef {string} InExport */",
        "  return 1;",
        "};",
        "class Cls {",
        "  method() {",
        "    /** @typedef {string} InMethod */",
        "    return 1;",
        "  }",
        "}",
      ],
    ],
    [
      "an ES module",
      "input.js",
      ["/** @typedef {string} Exported */", "export const x = 1;", "/** @callback Tail */"],
    ],
    ["a script", "input.js", ["/** @typedef {string} Global */", "var x = 1;"]],
    [
      "recorded exceptions",
      "input.js",
      [
        "/** @typedef {string} */",
        "var Nameless;",
        "/** @typedef {string} ns.Dotted */",
        "var ns = {};",
        "class Host {",
        "  /** @typedef {string} OnMember */",
        "  member() {}",
        "}",
        "const object = {",
        "  /** @typedef {string} OnProperty */",
        "  property: 1,",
        "};",
      ],
    ],
  ])("lists exactly the type aliases the binder declares for %s", (_case, filePath, lines) => {
    const sourceFile = programSourceFile(filePath, lines.join("\n"));

    expect(listedTypeAliases(sourceFile)).toEqual(binderTypeAliases(sourceFile));
  });
});

interface BoundNode extends ts.Node {
  readonly symbol?: ts.Symbol;
  readonly locals?: ts.SymbolTable;
}

function programSourceFile(filePath: string, source: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile(`/${filePath}`, source);
  sourceFile.getPreEmitDiagnostics();
  return sourceFile;
}

function listedTypeAliases(sourceFile: SourceFile): readonly string[] {
  const { declarationNodes } = FileDeclarationExtraction.extract({
    sourceFile,
    filePath: "input.js",
  });
  return [...declarationNodes]
    .filter(([declaration]) => declaration.kind.nativeLabel === "type-alias")
    .map(([declaration, node]) => {
      const path = declaration.identity.segments.map((segment) => segment.name).join("::");
      return `${path}@${node.getStartLineNumber()}`;
    })
    .sort();
}

function binderTypeAliases(sourceFile: SourceFile): readonly string[] {
  const owners = new Map<ts.JSDocTypedefTag | ts.JSDocCallbackTag, ts.Node>();
  const collect = (table: ts.SymbolTable | undefined, owner: ts.Node) => {
    table?.forEach((symbol) => {
      for (const declaration of symbol.declarations ?? []) {
        const isTypeAliasTag =
          ts.isJSDocTypedefTag(declaration) || ts.isJSDocCallbackTag(declaration);
        if (isTypeAliasTag && !owners.has(declaration)) owners.set(declaration, owner);
      }
    });
  };
  const file = sourceFile.compilerNode as BoundNode;
  collect(file.symbol?.exports, file);
  const visit = (node: ts.Node) => {
    collect((node as BoundNode).locals, node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...owners]
    .flatMap(([tag, owner]) => {
      const name = tag.fullName;
      const isListable = name !== undefined && ts.isIdentifier(name) && isStatementListHost(tag);
      if (!isListable) return [];
      const { line } = sourceFile.getLineAndColumnAtPos(name.getStart(sourceFile.compilerNode));
      return [`${[...scopeNamesOf(owner), name.text].join("::")}@${line}`];
    })
    .sort();
}

function isStatementListHost(tag: ts.JSDocTypedefTag | ts.JSDocCallbackTag): boolean {
  const host = tag.parent.parent;
  if (host.kind === ts.SyntaxKind.EndOfFileToken) return true;
  const list = host.parent;
  return (
    ts.isSourceFile(list) || ts.isBlock(list) || ts.isCaseClause(list) || ts.isDefaultClause(list)
  );
}

function scopeNamesOf(owner: ts.Node): readonly string[] {
  const names: string[] = [];
  for (let node: ts.Node | undefined = owner; node; node = node.parent) {
    const name = scopeNameOf(node);
    if (name !== undefined) names.unshift(name);
  }
  return names;
}

function scopeNameOf(node: ts.Node): string | undefined {
  const isScope = ts.isFunctionLike(node) || ts.isClassDeclaration(node);
  if (!isScope) return undefined;
  const ownName = (node as ts.Node & { readonly name?: ts.Node }).name;
  if (ownName && ts.isIdentifier(ownName)) return ownName.text;
  const owner = node.parent;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  const assignsProperty = ts.isBinaryExpression(owner) && ts.isPropertyAccessExpression(owner.left);
  return assignsProperty ? owner.left.name.text : undefined;
}

interface DeclarationSummary {
  readonly id: string;
  readonly label: string;
  readonly range: readonly [number, number];
  readonly header: readonly string[];
}

function summariesOf(source: string): readonly DeclarationSummary[] {
  return symbolsOf(source).map((symbol) => ({
    id: idOf(symbol),
    label: symbol.kind.nativeLabel,
    range: [symbol.range.startLine, symbol.range.endLine],
    header: symbol.header.lines,
  }));
}

function idsOf(source: string, filePath: string = "input.js"): readonly string[] {
  return symbolsOf(source, filePath).map(idOf);
}

function symbolsOf(source: string, filePath: string = "input.js"): readonly SymbolOverviewNode[] {
  const sourceFile = parseTypeScriptSource(source, filePath);
  return OverviewTree.walkSymbols(extractFileEntries({ sourceFile, filePath }).entries);
}

function idOf(symbol: SymbolOverviewNode): string {
  return formatSymbolIdentity(symbol.identity);
}
