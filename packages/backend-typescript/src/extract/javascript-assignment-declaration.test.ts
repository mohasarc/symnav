import { describe, expect, it } from "vitest";
import { Node, Project, ts, type SourceFile, type Symbol } from "ts-morph";
import {
  OverviewTree,
  SEGMENT_SEPARATOR,
  formatSymbolIdentity,
  type SymbolOverviewNode,
} from "@symnav/core";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { DeclarationLocator } from "../identity/locate-declarations.js";
import { extractFileEntries } from "./extract-file-entries.js";
import { FileDeclarationExtraction } from "./file-declaration-extraction.js";

describe("CommonJS export declarations in overview", () => {
  it.each([
    [
      "exports.foo",
      "exports.foo = function (a) { return a; };",
      "exports.foo = function (a) { return a; }",
    ],
    ["module.exports.foo", "module.exports.foo = (a) => a;", "module.exports.foo = (a) => a"],
  ])("lists %s with a function value as a function implementation", (_form, source, header) => {
    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::foo",
        label: "function-implementation",
        range: [1, 1],
        header: [header],
      },
    ]);
  });

  it("lists a non-function export property as a variable spanning its statement", () => {
    const source = ["exports.config = {", "  retries: 3,", "};"].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::config",
        label: "variable",
        range: [1, 3],
        header: ["exports.config = { … }"],
      },
    ]);
  });

  it("lists each export property of an assignment chain against the assigned value", () => {
    expect(summariesOf("exports.a = module.exports.b = 3;")).toEqual([
      { id: "input.js::a", label: "variable", range: [1, 1], header: ["exports.a = 3"] },
      { id: "input.js::b", label: "variable", range: [1, 1], header: ["module.exports.b = 3"] },
    ]);
  });

  it("lists export properties assigned in a comma sequence or inside parentheses", () => {
    expect(idsOf("exports.a = 1, exports.b = 2;\n(exports.c = 3);")).toEqual([
      "input.js::a",
      "input.js::b",
      "input.js::c",
    ]);
  });

  it("lists export properties named by a string, template or numeric element access", () => {
    const source = [
      'exports["x"] = 1;',
      'module["exports"].y = 2;',
      'module.exports["z"] = 3;',
      "exports[`t`] = 4;",
      "exports[0x10] = 5;",
    ].join("\n");

    expect(summariesOf(source).map((summary) => [summary.id, summary.header])).toEqual([
      ["input.js::x", ['exports["x"] = 1']],
      ["input.js::y", ['module["exports"].y = 2']],
      ["input.js::z", ['module.exports["z"] = 3']],
      ["input.js::t", ["exports[`t`] = 4"]],
      ["input.js::16", ["exports[0x10] = 5"]],
    ]);
  });

  it("emits no node for an export name a canonical id cannot spell or a computed key", () => {
    expect(idsOf('exports["a::b"] = 1;\nexports["x#2"] = 2;\nexports[key] = 3;')).toEqual([]);
  });

  it("nests declarations from a function value's body under the export", () => {
    const source = ["exports.foo = function () {", "  function inner() {}", "};"].join("\n");

    expect(idsOf(source)).toEqual(["input.js::foo", "input.js::foo::inner"]);
  });

  it("emits no node for an export property aliasing a same-name local", () => {
    const source = ["function foo() {}", "exports.foo = foo;", "exports.bar = foo;"].join("\n");

    expect(idsOf(source)).toEqual(["input.js::foo", "input.js::bar"]);
  });

  it("emits no node for a void 0 export placeholder", () => {
    expect(summariesOf("exports.foo = exports.bar = void 0;")).toEqual([]);
  });

  it("lists export properties assigned inside a top-level block", () => {
    const source = [
      "if (typeof window === 'undefined') {",
      "  exports.server = true;",
      "}",
      "if (typeof window !== 'undefined') exports.client = true;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::server", "input.js::client"]);
  });

  it("lists an export assigned in a variable initializer at module level after the variable", () => {
    expect(summariesOf("var app = module.exports.app = function () {};")).toEqual([
      {
        id: "input.js::app#1",
        label: "variable",
        range: [1, 1],
        header: ["var app = module.exports.app = function () {}"],
      },
      {
        id: "input.js::app#2",
        label: "function-implementation",
        range: [1, 1],
        header: ["module.exports.app = function () {}"],
      },
    ]);
  });

  it("lists exports assigned inside function bodies at module level after their statement", () => {
    const source = [
      "function init() {",
      "  exports.inner = 1;",
      "}",
      "function wrap(exports) {",
      "  exports.shadowed = 2;",
      "}",
      "(function () {",
      "  exports.iife = 3;",
      "})();",
      "const later = () => (exports.late = 4);",
    ].join("\n");

    const topLevel = OverviewTree.directSymbolChildren(fileEntriesOf(source).entries);

    expect(topLevel.map(idOf)).toEqual([
      "input.js::init",
      "input.js::inner",
      "input.js::wrap",
      "input.js::shadowed",
      "input.js::iife",
      "input.js::later",
      "input.js::late",
    ]);
    expect(idsOf(source)).toHaveLength(topLevel.length);
  });

  it("lists the members of a module.exports object literal", () => {
    const source = [
      "function a() {}",
      "module.exports = {",
      "  a,",
      "  b(x) {",
      "    return x;",
      "  },",
      "  c: 1,",
      "  d: function () {},",
      "};",
    ].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::a",
        label: "function-implementation",
        range: [1, 1],
        header: ["function a()"],
      },
      { id: "input.js::b", label: "function-implementation", range: [4, 6], header: ["b(x)"] },
      { id: "input.js::c", label: "variable", range: [7, 7], header: ["c: 1"] },
      {
        id: "input.js::d",
        label: "function-implementation",
        range: [8, 8],
        header: ["d: function () {}"],
      },
    ]);
  });

  it("lists module.exports object accessors and literal-named members", () => {
    const source = [
      "module.exports = {",
      "  get size() { return 1; },",
      "  set size(value) {},",
      '  ["computed"]: 1,',
      "  7: 2,",
      "  0x10: 3,",
      '  "dash-key": 4,',
      "  [`template`]: 5,",
      "  [dynamic]: 6,",
      "  ...rest,",
      "};",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [summary.id, summary.label, summary.header]),
    ).toEqual([
      ["input.js::size#1", "getter", ["get size()"]],
      ["input.js::size#2", "setter", ["set size(value)"]],
      ["input.js::computed", "variable", ['["computed"]: 1']],
      ["input.js::7", "variable", ["7: 2"]],
      ["input.js::16", "variable", ["0x10: 3"]],
      ["input.js::dash-key", "variable", ['"dash-key": 4']],
      ["input.js::template", "variable", ["[`template`]: 5"]],
    ]);
  });

  it("lists the members of a parenthesized or chained module.exports object literal", () => {
    expect(idsOf("module.exports = ({ a: 1 });\nmodule.exports = exports = { b: 2 };")).toEqual([
      "input.js::a",
      "input.js::b",
    ]);
  });

  it("nests declarations from a module.exports method body under the member", () => {
    const source = ["module.exports = {", "  b() {", "    function inner() {}", "  },", "};"].join(
      "\n",
    );

    expect(idsOf(source)).toEqual(["input.js::b", "input.js::b::inner"]);
  });

  it("lists module.exports assigned a function as the default export", () => {
    const source = ["module.exports = function named(a) {", "  function inner() {}", "};"].join(
      "\n",
    );

    expect(summariesOf(source)[0]).toEqual({
      id: "input.js::default",
      label: "default-export",
      range: [1, 3],
      header: ["module.exports = function named(a) …"],
    });
    expect(idsOf(source)).toEqual(["input.js::default", "input.js::default::inner"]);
  });

  it("lists module.exports assigned a local as the default export", () => {
    const source = ["function Foo() {}", 'module["exports"] = Foo;'].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::Foo",
        label: "function-implementation",
        range: [1, 1],
        header: ["function Foo()"],
      },
      {
        id: "input.js::default",
        label: "default-export",
        range: [2, 2],
        header: ['module["exports"] = Foo'],
      },
    ]);
  });

  it("emits no default export for module.exports assigned exports itself", () => {
    expect(idsOf("module.exports = exports;\nmodule.exports = module.exports;")).toEqual([]);
  });

  it.each(["exports", "module.exports"])(
    "lists Object.defineProperty on %s with a function value as a function implementation",
    (owner) => {
      const source = `Object.defineProperty(${owner}, "run", { value: function () {} });`;

      expect(summariesOf(source)).toEqual([
        {
          id: "input.js::run",
          label: "function-implementation",
          range: [1, 1],
          header: [`Object.defineProperty(${owner}, "run", { value: function () {} })`],
        },
      ]);
    },
  );

  it("lists an Object.defineProperty getter export as a variable spanning its statement", () => {
    const source = [
      'Object.defineProperty(exports, "foo", {',
      "  enumerable: true,",
      "  get: function () {",
      "    return lib.foo;",
      "  },",
      "});",
    ].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::foo",
        label: "variable",
        range: [1, 6],
        header: ['Object.defineProperty(exports, "foo", { … })'],
      },
    ]);
  });

  it("lists Object.defineProperty exports named by a numeric or template literal", () => {
    const source = [
      "Object.defineProperty(exports, 1, { value: 1 });",
      'Object.defineProperty(module["exports"], `t`, { value: 2 });',
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::1", "input.js::t"]);
  });

  it("emits no node for Object.defineProperty on another object", () => {
    expect(summariesOf('Object.defineProperty(target, "x", { value: 1 });')).toEqual([]);
  });

  it("emits no node for CommonJS export syntax in a file with ES module syntax", () => {
    const source = [
      'import helper from "./helper";',
      "exports.foo = 1;",
      'exports["bar"] = 2;',
      "function init() {",
      "  module.exports.inner = 3;",
      "}",
      "export const real = helper;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::init", "input.js::real"]);
  });

  it("emits no symbols for the same syntax in a TypeScript file", () => {
    const source = [
      "exports.foo = function () {};",
      "module.exports.bar = 1;",
      "module.exports = { baz: 1 };",
      "module.exports = qux;",
      'Object.defineProperty(exports, "quux", { value: 1 });',
    ].join("\n");

    expect(OverviewTree.walkSymbols(fileEntriesOf(source, "input.ts").entries)).toEqual([]);
  });
});

describe("expando prototype members in overview", () => {
  it("lists Foo.prototype properties under the function, as methods for function values", () => {
    const source = [
      "function Foo() {}",
      "Foo.prototype.bar = function (a) { return a; };",
      "Foo.prototype.baz = 1;",
      "Foo.prototype.multi = function () {",
      "  return 2;",
      "};",
    ].join("\n");

    expect(summariesOf(source)).toEqual([
      {
        id: "input.js::Foo",
        label: "function-implementation",
        range: [1, 1],
        header: ["function Foo()"],
      },
      {
        id: "input.js::Foo::bar",
        label: "method-implementation",
        range: [2, 2],
        header: ["Foo.prototype.bar = function (a) { return a; }"],
      },
      {
        id: "input.js::Foo::baz",
        label: "property",
        range: [3, 3],
        header: ["Foo.prototype.baz = 1"],
      },
      {
        id: "input.js::Foo::multi",
        label: "method-implementation",
        range: [4, 6],
        header: ["Foo.prototype.multi = function () …"],
      },
    ]);
  });

  it("orders prototype members by line among the container's own children", () => {
    const source = [
      "Foo.prototype.early = 1;",
      "function Foo() {",
      "  function inner() {}",
      "}",
      "Foo.prototype.late = 2;",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::Foo",
      "input.js::Foo::early",
      "input.js::Foo::inner",
      "input.js::Foo::late",
    ]);
  });

  it.each([
    ["a function expression", "var Foo = function () {};"],
    ["an arrow function", "const Foo = () => {};"],
    ["a class declaration", "class Foo {}"],
    ["a class expression", "const Foo = class {};"],
    ["any other value", "let Foo = make();"],
  ])("lists prototype members of a container declared as %s", (_container, declaration) => {
    expect(idsOf(`${declaration}\nFoo.prototype.m = 1;\nFoo.prototype["lit"] = 2;`)).toEqual([
      "input.js::Foo",
      "input.js::Foo::m",
      "input.js::Foo::lit",
    ]);
  });

  it("lists prototype members of a container declared in the same function", () => {
    const source = [
      "function outer() {",
      "  function Foo() {}",
      "  if (ready) {",
      "    Foo.prototype.m = 1;",
      "  }",
      "}",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::outer",
      "input.js::outer::Foo",
      "input.js::outer::Foo::m",
    ]);
  });

  it("nests declarations from a prototype method's body under the member", () => {
    const source = [
      "function Foo() {}",
      "Foo.prototype.bar = function () {",
      "  function helper() {}",
      "};",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::Foo",
      "input.js::Foo::bar",
      "input.js::Foo::bar::helper",
    ]);
  });

  it("emits no member for a prototype assigned outside its container's scope, on a parameter, or on an undeclared name", () => {
    const source = [
      "function Foo() {}",
      "function init(P) {",
      "  Foo.prototype.a = 1;",
      "  P.prototype.b = 2;",
      "}",
      "Bar.prototype.c = 3;",
      "Foo.prototype.d = void 0;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::Foo", "input.js::init"]);
  });

  it("emits no member for the same syntax in a TypeScript file", () => {
    const { entries } = fileEntriesOf("function Foo() {}\nFoo.prototype.bar = 1;", "input.ts");

    expect(OverviewTree.walkSymbols(entries).map(idOf)).toEqual(["input.ts::Foo"]);
  });
});

describe("expando prototype object members in overview", () => {
  it("lists the members of an object assigned to Foo.prototype under the function", () => {
    const source = [
      "function Foo() {}",
      "const qux = 3;",
      "Foo.prototype = {",
      "  bar(a) {",
      "    return a;",
      "  },",
      "  baz: 1,",
      "  get size() { return 2; },",
      "  qux,",
      '  ["lit"]: function () {},',
      "  ...rest,",
      "};",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [
        summary.id,
        summary.label,
        summary.range,
        summary.header,
      ]),
    ).toEqual([
      ["input.js::Foo", "function-implementation", [1, 1], ["function Foo()"]],
      ["input.js::Foo::bar", "method-implementation", [4, 6], ["bar(a)"]],
      ["input.js::Foo::baz", "property", [7, 7], ["baz: 1"]],
      ["input.js::Foo::size", "getter", [8, 8], ["get size()"]],
      ["input.js::Foo::qux", "property", [9, 9], ["qux"]],
      ["input.js::Foo::lit", "method-implementation", [10, 10], ['["lit"]: function () {}']],
      ["input.js::qux", "variable", [2, 2], ["const qux = 3"]],
    ]);
  });

  it.each([
    ["a class declaration", "class Foo {}"],
    ["a function expression", "var Foo = function () {};"],
  ])("lists prototype object members of a container declared as %s", (_container, declaration) => {
    expect(idsOf(`${declaration}\nFoo.prototype = { m() {} };`)).toEqual([
      "input.js::Foo",
      "input.js::Foo::m",
    ]);
  });

  it("lists the members of a chained prototype object under the container assigned it directly", () => {
    const source = [
      "function Foo() {}",
      "function Bar() {}",
      "Foo.prototype = Bar.prototype = { m() {} };",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::Foo", "input.js::Bar", "input.js::Bar::m"]);
  });

  it("nests declarations from a prototype object method's body under the member", () => {
    const source = [
      "function Foo() {}",
      "Foo.prototype = {",
      "  m() {",
      "    function helper() {}",
      "  },",
      "};",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::Foo",
      "input.js::Foo::m",
      "input.js::Foo::m::helper",
    ]);
  });
});

describe("expando static members in overview", () => {
  it("lists static properties of a function and a class under the container", () => {
    const source = [
      "function Foo() {}",
      "Foo.make = function () {};",
      "Foo.count = 0;",
      "class Bar {}",
      "Bar.instance = new Bar();",
      'Bar["lit"] = () => 1;',
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [summary.id, summary.label, summary.header]),
    ).toEqual([
      ["input.js::Foo", "function-implementation", ["function Foo()"]],
      ["input.js::Foo::make", "method-implementation", ["Foo.make = function () {}"]],
      ["input.js::Foo::count", "property", ["Foo.count = 0"]],
      ["input.js::Bar", "class", ["class Bar"]],
      ["input.js::Bar::instance", "property", ["Bar.instance = new Bar()"]],
      ["input.js::Bar::lit", "method-implementation", ['Bar["lit"] = () => 1']],
    ]);
  });

  it("lists each static property of an assignment chain and a static next to a same-name prototype member", () => {
    const source = [
      "function Foo() {}",
      "Foo.a = Foo.b = 1;",
      "Foo.x = 2;",
      "Foo.prototype.x = 3;",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::Foo",
      "input.js::Foo::a",
      "input.js::Foo::b",
      "input.js::Foo::x#1",
      "input.js::Foo::x#2",
    ]);
  });

  it("lists a prototype assigned anything but an object literal as a static property", () => {
    const source = [
      "function Foo() {}",
      "Foo.prototype = Object.create(Base.prototype);",
      "function Bar() {}",
      "Bar.prototype = ({ m() {} });",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::Foo",
      "input.js::Foo::prototype",
      "input.js::Bar",
      "input.js::Bar::prototype",
    ]);
  });

  it("emits no static member on a nested-scope local without an expando value, a parameter, or an outer-scope container", () => {
    const source = [
      "function Foo() {}",
      "function init(p) {",
      "  let made = make();",
      "  made.x = 1;",
      "  p.y = 2;",
      "  Foo.z = 3;",
      "}",
      "Foo.w = void 0;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::Foo", "input.js::init", "input.js::init::made"]);
  });
});

describe("CommonJS export declarations against the TypeScript binder", () => {
  it.each([
    [
      "compiled CommonJS output",
      [
        '"use strict";',
        'Object.defineProperty(exports, "__esModule", { value: true });',
        "exports.first = exports.second = void 0;",
        "function local() {}",
        "exports.local = local;",
        "exports.first = function () {};",
        "module.exports.second = 2;",
        "exports.third = module.exports.fourth = 4;",
        'Object.defineProperty(exports, "fifth", { enumerable: true, get: function () { return 5; } });',
        "exports.first = 6;",
        "exports.first.nested = 7;",
      ],
    ],
    [
      "exports outside module-level expression statements",
      [
        "var app = module.exports.app = function () {};",
        "var _default = exports.default = 1;",
        "exports.a = 1, exports.b = 2;",
        "(exports.p = 3);",
        "if (typeof window === 'undefined') exports.server = true;",
        "function init() {",
        "  exports.inner = 1;",
        "  const nested = { deep: 1 };",
        "}",
        "function wrap(exports) {",
        "  exports.shadowed = 2;",
        "}",
        "(function () {",
        "  exports.iife = 3;",
        "})();",
        "factory(function (root) {",
        "  exports.umd = 4;",
        "});",
        "const later = () => (exports.late = 5);",
      ],
    ],
    [
      "literal-named exports",
      [
        'exports["x"] = 1;',
        'module["exports"].y = 2;',
        'module.exports["z"] = 3;',
        "exports[`t`] = 4;",
        "exports[0x10] = 5;",
        "exports[key] = 6;",
        'exports["a::b"] = 7;',
        'exports["c#2"] = 8;',
        "Object.defineProperty(exports, 1, { value: 9 });",
        "Object.defineProperty(module.exports, `u`, { value: 10 });",
        'Object.defineProperty(target, "other", { value: 11 });',
      ],
    ],
    [
      "a module.exports object",
      [
        "function a() {}",
        "const rest = { spread: 1 };",
        "module.exports = {",
        "  a,",
        "  b() {},",
        "  c: 1,",
        '  "d": function () {},',
        "  get size() { return 1; },",
        "  set size(value) {},",
        '  ["computed"]: 2,',
        "  7: 3,",
        "  0x10: 4,",
        "  [`template`]: 5,",
        "  [dynamic]: 6,",
        "  ...rest,",
        "  nested: { inner: 7 },",
        "};",
      ],
    ],
    ["a parenthesized module.exports object", ["module.exports = exports = ({ a: 1 });"]],
    ["a module.exports value", ["module.exports = function () {};", "module.exports.extra = 1;"]],
    ["module.exports assigned exports", ["module.exports = exports;", "exports.z = 1;"]],
    [
      "a file with ES module syntax",
      [
        'import helper from "./helper";',
        "exports.foo = 1;",
        "module.exports.bar = 2;",
        'Object.defineProperty(exports, "baz", { value: 3 });',
        "export const real = helper;",
      ],
    ],
  ])("lists exactly the exports the binder declares for %s", (_case, lines) => {
    const sourceFile = programSourceFile(lines.join("\n"));

    expect(listedExports(sourceFile)).toEqual(binderExports(sourceFile));
  });
});

function programSourceFile(source: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile("/input.js", source);
  sourceFile.getPreEmitDiagnostics();
  return sourceFile;
}

function listedExports(sourceFile: SourceFile): readonly string[] {
  const located = locatedDeclarationsOf(sourceFile);
  return located
    .filter(({ node }) => isCommonJsDeclarationNode(node))
    .map(({ declaration, node }) => {
      const path = declaration.identity.segments.map((segment) => segment.name);
      return `${path.join(SEGMENT_SEPARATOR)}@${node.getStartLineNumber()}`;
    })
    .sort();
}

function locatedDeclarationsOf(
  sourceFile: SourceFile,
): readonly { readonly declaration: SymbolOverviewNode; readonly node: Node }[] {
  const { entries, declarationNodes } = FileDeclarationExtraction.extract({
    sourceFile,
    filePath: "input.js",
  });
  const located = [...declarationNodes]
    .filter(([declaration, node]) => DeclarationLocator.spanOf(declaration, node) !== undefined)
    .map(([declaration, node]) => ({ declaration, node }));
  expect(located).toHaveLength(OverviewTree.walkSymbols(entries.entries).length);
  return located;
}

function isCommonJsDeclarationNode(node: Node): boolean {
  if (
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node) ||
    Node.isCallExpression(node)
  ) {
    return true;
  }
  return Node.isObjectLiteralExpression(node.getParent());
}

function binderExports(sourceFile: SourceFile): readonly string[] {
  return sourceFile
    .getSymbolOrThrow()
    .getExports()
    .flatMap((exported) => {
      if (exported.getName() === ts.InternalSymbolName.ExportEquals) {
        return exportEqualsDeclarations(exported, sourceFile);
      }
      if (aliasesSameNameLocal(exported) || !spellsCanonicalId(exported.getName())) return [];
      return exported
        .getDeclarations()
        .filter(isCommonJsDeclarationNode)
        .map((declaration) => `${exported.getName()}@${declaration.getStartLineNumber()}`);
    })
    .sort();
}

function exportEqualsDeclarations(exportEquals: Symbol, sourceFile: SourceFile): readonly string[] {
  const [assignment] = exportEquals.getDeclarations();
  if (!Node.isBinaryExpression(assignment)) return [];
  const object = rightmostAssignedObject(assignment.getRight());
  if (!object) return [`default@${assignment.getStartLineNumber()}`];
  const members = sourceFile
    .getProject()
    .getTypeChecker()
    .getTypeOfSymbolAtLocation(exportEquals, sourceFile)
    .getProperties();
  return members.flatMap((member) =>
    member
      .getDeclarations()
      .filter(
        (declaration) =>
          declaration.getParent() === object && !Node.isShorthandPropertyAssignment(declaration),
      )
      .map((declaration) => `${member.getName()}@${declaration.getStartLineNumber()}`),
  );
}

function rightmostAssignedObject(value: Node): Node | undefined {
  if (Node.isParenthesizedExpression(value)) return rightmostAssignedObject(value.getExpression());
  if (Node.isBinaryExpression(value)) return rightmostAssignedObject(value.getRight());
  return Node.isObjectLiteralExpression(value) ? value : undefined;
}

function aliasesSameNameLocal(exported: Symbol): boolean {
  return exported.isAlias() && exported.getAliasedSymbol()?.getName() === exported.getName();
}

function spellsCanonicalId(name: string): boolean {
  return !name.includes(SEGMENT_SEPARATOR) && !/#[1-9][0-9]*$/.test(name);
}

interface DeclarationSummary {
  readonly id: string;
  readonly label: string;
  readonly range: readonly [number, number];
  readonly header: readonly string[];
}

function summariesOf(source: string): readonly DeclarationSummary[] {
  return OverviewTree.walkSymbols(fileEntriesOf(source).entries).map((symbol) => ({
    id: idOf(symbol),
    label: symbol.kind.nativeLabel,
    range: [symbol.range.startLine, symbol.range.endLine],
    header: symbol.header.lines,
  }));
}

function idsOf(source: string): readonly string[] {
  return OverviewTree.walkSymbols(fileEntriesOf(source).entries).map(idOf);
}

function fileEntriesOf(source: string, filePath: string = "input.js") {
  return extractFileEntries({ sourceFile: parseTypeScriptSource(source, filePath), filePath });
}

function idOf(symbol: SymbolOverviewNode): string {
  return formatSymbolIdentity(symbol.identity);
}
