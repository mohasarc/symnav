import { describe, expect, it } from "vitest";
import {
  Node,
  Project,
  ts,
  type BinaryExpression,
  type ObjectLiteralExpression,
  type SourceFile,
  type Symbol,
} from "ts-morph";
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

  it("lists module-level this-properties assigned after the file becomes CommonJS as exports", () => {
    const source = [
      "this.early = 1;",
      "exports.a = 2;",
      "this.after = function () {};",
      "if (ready) {",
      "  this.inBlock = 3;",
      "}",
      "this.after = 4;",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [
        summary.id,
        summary.label,
        summary.range,
        summary.header,
      ]),
    ).toEqual([
      ["input.js::a", "variable", [2, 2], ["exports.a = 2"]],
      ["input.js::after#1", "function-implementation", [3, 3], ["this.after = function () {}"]],
      ["input.js::inBlock", "variable", [5, 5], ["this.inBlock = 3"]],
      ["input.js::after#2", "variable", [7, 7], ["this.after = 4"]],
    ]);
  });

  it.each([
    ["a script", "this.global = 1;"],
    ["a file with ES module syntax", "export const a = 1;\nthis.local = 2;"],
  ])("emits no export for a module-level this-property in %s", (_file, source) => {
    expect(idsOf(source).filter((id) => id !== "input.js::a")).toEqual([]);
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

  it("orders members by position among the container's own children on the same line", () => {
    const oneLine = "Late.m = 1; Late.prototype.m = 2; function Late() { function m() {} }";
    const formatted = [
      "Late.m = 1;",
      "Late.prototype.m = 2;",
      "function Late() {",
      "  function m() {}",
      "}",
    ].join("\n");

    expect(summariesOf(oneLine).map((summary) => [summary.id, summary.header])).toEqual([
      ["input.js::Late", ["function Late()"]],
      ["input.js::Late::m#1", ["Late.m = 1"]],
      ["input.js::Late::m#2", ["Late.prototype.m = 2"]],
      ["input.js::Late::m#3", ["function m()"]],
    ]);
    expect(idsOf(formatted)).toEqual(idsOf(oneLine));
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

  it("lists Object.defineProperty on a container and its prototype as members", () => {
    const source = [
      "function Foo() {}",
      'Object.defineProperty(Foo, "make", { value: function () {} });',
      'Object.defineProperty(Foo.prototype, "size", { get: function () { return 1; } });',
      "Object.defineProperty(Foo, 1, { value: 2 });",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [summary.id, summary.label, summary.header]),
    ).toEqual([
      ["input.js::Foo", "function-implementation", ["function Foo()"]],
      [
        "input.js::Foo::make",
        "method-implementation",
        ['Object.defineProperty(Foo, "make", { value: function () {} })'],
      ],
      [
        "input.js::Foo::size",
        "property",
        ['Object.defineProperty(Foo.prototype, "size", { get: function () { return 1; } })'],
      ],
      ["input.js::Foo::1", "property", ["Object.defineProperty(Foo, 1, { value: 2 })"]],
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

describe("expando namespace members in overview", () => {
  it("lists members of variables initialized with an empty object, a defaulted object, or an IIFE", () => {
    const source = [
      "const ns = {};",
      "ns.helper = function () {};",
      "const opts = defaults || {};",
      "opts.debug = true;",
      "var M = (function () { return {}; })();",
      "M.x = 1;",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [summary.id, summary.label, summary.header]),
    ).toEqual([
      ["input.js::ns", "variable", ["const ns = {}"]],
      ["input.js::ns::helper", "method-implementation", ["ns.helper = function () {}"]],
      ["input.js::opts", "variable", ["const opts = defaults || {}"]],
      ["input.js::opts::debug", "property", ["opts.debug = true"]],
      ["input.js::M", "variable", ["var M = (function () { return {}; })()"]],
      ["input.js::M::x", "property", ["M.x = 1"]],
    ]);
  });

  it("lists members of any module-level local", () => {
    expect(idsOf("let o = make();\no.x = 1;")).toEqual(["input.js::o", "input.js::o::x"]);
  });

  it("lists nested namespace members under the member that declares them", () => {
    const source = ["const a = {};", "a.b = {};", "a.b.c = 1;", "a.d.e = 2;"].join("\n");

    expect(idsOf(source)).toEqual(["input.js::a", "input.js::a::b", "input.js::a::b::c"]);
  });

  it("lists members of a CommonJS export under the export", () => {
    const source = [
      "exports.foo = function () {};",
      "exports.foo.bar = 1;",
      "module.exports.foo.baz = 2;",
    ].join("\n");

    expect(idsOf(source)).toEqual(["input.js::foo", "input.js::foo::bar", "input.js::foo::baz"]);
  });
});

describe("this-property members in overview", () => {
  it("lists this-properties of class constructors and methods under the class at their first assignment", () => {
    const source = [
      "class Foo {",
      "  constructor() {",
      "    this.kx = 1;",
      "  }",
      "  method() {",
      "    this.kx = 2;",
      '    this["km"] = function () {};',
      "    const later = () => {",
      "      this.ka = 3;",
      "    };",
      "  }",
      "  static make() {",
      "    this.ks = 4;",
      "  }",
      "}",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [
        summary.id,
        summary.label,
        summary.range,
        summary.header,
      ]),
    ).toEqual([
      ["input.js::Foo", "class", [1, 15], ["class Foo"]],
      ["input.js::Foo::constructor", "constructor-implementation", [2, 4], ["constructor()"]],
      ["input.js::Foo::kx", "property", [3, 3], ["this.kx = 1"]],
      ["input.js::Foo::method", "method-implementation", [5, 11], ["method()"]],
      ["input.js::Foo::method::later", "variable", [8, 10], ["const later = () => …"]],
      ["input.js::Foo::km", "method-implementation", [7, 7], ['this["km"] = function () {}']],
      ["input.js::Foo::ka", "property", [9, 9], ["this.ka = 3"]],
      ["input.js::Foo::make", "method-implementation", [12, 14], ["static make()"]],
      ["input.js::Foo::ks", "property", [13, 13], ["this.ks = 4"]],
    ]);
  });

  it("emits no member for a this-property that a class element already declares", () => {
    const source = [
      "class Foo {",
      "  declared = 0;",
      "  constructor() {",
      "    this.declared = 1;",
      "    this.bound = this.bound.bind(this);",
      "    this.#hidden = 2;",
      "  }",
      "  bound() {}",
      "  #hidden;",
      "}",
    ].join("\n");

    expect(idsOf(source)).toEqual([
      "input.js::Foo",
      "input.js::Foo::declared",
      "input.js::Foo::constructor",
      "input.js::Foo::bound",
      "input.js::Foo::#hidden",
    ]);
  });

  it("lists this-properties of constructor functions and prototype methods under the function", () => {
    const source = [
      "function Foo() {",
      "  this.x = 1;",
      "  function inner() {",
      "    this.q = 2;",
      "  }",
      "}",
      "Foo.prototype.meth = function () {",
      "  this.y = 3;",
      "  this.x = 4;",
      "};",
      "var Bar = function () {",
      "  this.z = 5;",
      "};",
      "Bar.prototype.z = 6;",
      "exports.Baz = function () { this.w = function () {}; };",
      "[1].forEach(function () { this.callback = 7; });",
    ].join("\n");

    expect(
      summariesOf(source).map((summary) => [
        summary.id,
        summary.label,
        summary.range,
        summary.header,
      ]),
    ).toEqual([
      ["input.js::Foo", "function-implementation", [1, 6], ["function Foo()"]],
      ["input.js::Foo::x", "property", [2, 2], ["this.x = 1"]],
      ["input.js::Foo::inner", "function-implementation", [3, 5], ["function inner()"]],
      ["input.js::Foo::inner::q", "property", [4, 4], ["this.q = 2"]],
      [
        "input.js::Foo::meth",
        "method-implementation",
        [7, 10],
        ["Foo.prototype.meth = function () …"],
      ],
      ["input.js::Foo::y", "property", [8, 8], ["this.y = 3"]],
      ["input.js::Bar", "variable", [11, 13], ["var Bar = function () …"]],
      ["input.js::Bar::z", "property", [14, 14], ["Bar.prototype.z = 6"]],
      [
        "input.js::Baz",
        "function-implementation",
        [15, 15],
        ["exports.Baz = function () { this.w = function () {}; }"],
      ],
      ["input.js::Baz::w", "method-implementation", [15, 15], ["this.w = function () {}"]],
    ]);
  });

  it("emits no member for the same syntax in a TypeScript file", () => {
    const source = "class Foo {\n  constructor() {\n    this.x = 1;\n  }\n}\n";

    expect(OverviewTree.walkSymbols(fileEntriesOf(source, "input.ts").entries).map(idOf)).toEqual([
      "input.ts::Foo",
      "input.ts::Foo::constructor",
    ]);
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
    [
      "module.exports assigned in fallback branches",
      [
        "try {",
        '  module.exports = require("./native");',
        "} catch (error) {",
        "  module.exports = null;",
        "}",
        "if (legacy) module.exports = legacy;",
        "else module.exports = { b: 1, c() {} };",
      ],
    ],
    ["module.exports assigned exports", ["module.exports = exports;", "exports.z = 1;"]],
    [
      "a file with ES module syntax",
      [
        'import helper from "./helper";',
        "exports.foo = 1;",
        "module.exports.bar = 2;",
        'Object.defineProperty(exports, "baz", { value: 3 });',
        "export const real = helper;",
        "this.local = 4;",
      ],
    ],
    [
      "module-level this-properties",
      [
        "this.early = 1;",
        "exports.a = 2;",
        "this.after = 3;",
        'this["lit"] = 4;',
        "this[dynamic] = 5;",
        "this.gone = void 0;",
        "if (ready) { this.inBlock = 6; }",
        "function init() { this.notExport = 7; }",
        "const arrow = () => { this.arrowed = 8; };",
        "this.after = 9;",
        "function local() {}",
        "this.local = local;",
      ],
    ],
  ])("lists exactly the exports the binder declares for %s", (_case, lines) => {
    const sourceFile = programSourceFile(lines.join("\n"));

    expect(listedExports(sourceFile)).toEqual(binderExports(sourceFile));
  });
});

describe("expando member declarations against the TypeScript binder", () => {
  it.each([
    [
      "prototype properties and prototype objects",
      [
        "function Foo() {}",
        "Foo.prototype.bar = function () {};",
        'Foo.prototype["lit"] = 1;',
        "Foo.prototype.gone = void 0;",
        "var Fn = function () {};",
        "Fn.prototype = {",
        "  method() { function inner() {} },",
        "  property: 1,",
        "  get size() { return 1; },",
        "  set size(value) {},",
        "  shorthand,",
        '  "dash-key": 2,',
        "  [dynamic]: 3,",
        "  ...rest,",
        "};",
        "class Cls {}",
        "Cls.prototype.extra = 1;",
        "const Expr = class {};",
        "Expr.prototype.m = 1;",
        "let made = make();",
        "made.prototype.p = 1;",
        'Object.defineProperty(Foo.prototype, "defined", { value: 1 });',
      ],
    ],
    [
      "static and namespace members",
      [
        "function Foo() {}",
        "Foo.make = function () {};",
        "Foo.a = Foo.b = 1;",
        'Foo["lit"] = 2;',
        'Foo["a::b"] = 3;',
        'Object.defineProperty(Foo, "defined", { value: 4 });',
        "Foo.prototype = Object.create(Base.prototype);",
        "class Cls {}",
        "Cls.instance = new Cls();",
        "const ns = {};",
        "ns.helper = function () {};",
        "const opts = defaults || {};",
        "opts.debug = true;",
        "const nullish = defaults ?? {};",
        "nullish.debug = true;",
        "var M = (function () { return {}; })();",
        "M.x = 1;",
        "const filled = { a: 1 };",
        "filled.b = 2;",
        "if (ready) { filled.c = 3; }",
        "let any = make();",
        "any.x = 1;",
        "const a = {};",
        "a.b = {};",
        "a.b.c = 1;",
        "a.d.e = 2;",
        "Undeclared.x = 1;",
        "window.y = 2;",
      ],
    ],
    [
      "containers in nested scopes",
      [
        "function outer(P) {",
        "  function Foo() {}",
        "  Foo.prototype.m = 1;",
        "  Foo.s = 2;",
        "  let made = make();",
        "  made.x = 3;",
        "  made.prototype.y = 4;",
        "  const ns = {};",
        "  ns.z = 5;",
        "  P.prototype.q = 6;",
        "}",
        "const arrow = () => {",
        "  function Bar() {}",
        "  Bar.s = 1;",
        "};",
        "function Top() {}",
        "function init() {",
        "  Top.late = 1;",
        "}",
        "if (ready) {",
        "  function Block() {}",
        "}",
        "Block.x = 1;",
      ],
    ],
    [
      "CommonJS export containers",
      [
        "exports.foo = function () {};",
        "exports.foo.bar = 1;",
        "module.exports.foo.baz = 2;",
        'exports.foo["lit"] = 3;',
        "exports.missing.member = 4;",
      ],
    ],
    [
      "one-line code with same-name members",
      [
        "function Foo() { function Foo() {} } Foo.Foo = 1; Foo.prototype.Foo = function () { function Foo() {} }; var ns = {}; ns.ns = function () { function ns() {} };",
        "exports.make = function () { function Foo() {} Foo.Foo = function () { function Foo() {} }; };",
        "var A = class B { m() { function m() {} } }; A.m = 1; var S = class { static n() {} }; S.n = function () { function n() {} };",
        "var o = { m() { function m() {} } }; o.m = 1; Late.m = 1; function Late() { function m() {} }",
      ],
    ],
    [
      "a file with ES module syntax",
      [
        'import def from "./x";',
        "def.y = 1;",
        "export function F() {}",
        "F.z = 2;",
        "F.prototype.m = 1;",
        "export default function () { function Foo() {} Foo.x = 1; function x() {} }",
        "exports.foo = function () {};",
        "exports.foo.bar = 1;",
      ],
    ],
    [
      "this-property assignments",
      [
        "function Foo() {",
        "  this.x = 1;",
        "  var self = this;",
        "  self.y = 2;",
        "  this.x = 3;",
        '  this["lit"] = 4;',
        "  this[dynamic] = 5;",
        "  this.gone = void 0;",
        "  const arrow = () => { this.arrowed = 6; };",
        "  function inner() { this.innerOwn = 7; }",
        "}",
        "Foo.prototype.z = 3;",
        "Foo.prototype.meth = function () { this.fromMethod = 1; this.z = 2; };",
        "Foo.s = function () { this.onStatic = 1; };",
        "var Bar = function () { this.barOwn = 1; this.dup = 2; };",
        "Bar.prototype.dup = 3;",
        "exports.Qux = function () { this.quxOwn = 1; };",
        "[1].forEach(function () { this.callback = 1; });",
        "var o = { m() { this.onObject = 1; } };",
        "function Proto() {}",
        "Proto.prototype = { m() { this.onPrototypeObject = 1; } };",
        "class Cls {",
        "  declared = 0;",
        "  #hidden;",
        "  field = this.fromField = 1;",
        "  constructor() {",
        "    this.declared = 1;",
        "    this.bound = this.bound.bind(this);",
        "    this.own = 2;",
        "    this.#hidden = 3;",
        "  }",
        "  bound() {}",
        "  static make() { this.shared = 1; }",
        "  static { this.fromBlock = 1; }",
        "}",
        "var Expr = class { constructor() { this.exprOwn = 1; } };",
      ],
    ],
  ])("lists exactly the expando members the binder declares for %s", (_case, lines) => {
    const sourceFile = programSourceFile(lines.join("\n"));

    expect(listedMembers(sourceFile)).toEqual(binderMembers(sourceFile));
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

interface BoundNode extends ts.Node {
  readonly symbol?: BoundSymbol;
}

interface BoundSymbol extends ts.Symbol {
  readonly parent?: BoundSymbol;
}

function listedMembers(sourceFile: SourceFile): readonly string[] {
  return locatedDeclarationsOf(sourceFile)
    .filter(({ node }) => isExpandoMemberNode(node))
    .map(({ declaration, node }) => {
      const [container, member] = declaration.identity.segments.slice(-2);
      return `${container?.name}::${member?.name}@${node.getStartLineNumber()}`;
    })
    .sort();
}

function isExpandoMemberNode(node: Node): boolean {
  const isAccessOrCall =
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node) ||
    Node.isCallExpression(node);
  if (isAccessOrCall) return !isModuleLevelExport(node);
  const object = node.getParent();
  const assignment = object?.getParent();
  return (
    Node.isObjectLiteralExpression(object) &&
    Node.isBinaryExpression(assignment) &&
    /\.prototype$/.test(assignment.getLeft().getText())
  );
}

function isModuleLevelExport(node: Node): boolean {
  const declaringNode = isThisAccess(node) ? node.getParentOrThrow() : node;
  const symbol = (declaringNode.compilerNode as BoundNode).symbol;
  return symbol?.parent === (node.getSourceFile().compilerNode as BoundNode).symbol;
}

function binderMembers(sourceFile: SourceFile): readonly string[] {
  const members: string[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isBinaryExpression(node) && isThisAccess(node.getLeft())) {
      members.push(...binderThisMember(node));
      return;
    }
    const symbol = (node.compilerNode as BoundNode).symbol;
    const container = symbol?.parent;
    const declaresMember =
      (Node.isPropertyAccessExpression(node) ||
        Node.isElementAccessExpression(node) ||
        Node.isCallExpression(node)) &&
      symbol?.declarations?.includes(node.compilerNode as ts.Declaration) === true &&
      container !== undefined &&
      !isModuleLevelExport(node) &&
      isListableContainer(container);
    if (!symbol || !container || !declaresMember) return;
    const containerName = ts.symbolName(container);
    const prototypeObject = assignedPrototypeObject(node, symbol);
    const memberEntries = prototypeObject
      ? prototypeObject.getProperties().flatMap((property) => {
          const name = Node.hasName(property) ? property.getName() : undefined;
          return name === undefined || Node.isSpreadAssignment(property)
            ? []
            : [[property, unquoted(name)] as const];
        })
      : [[node, ts.symbolName(symbol)] as const];
    for (const [memberNode, name] of memberEntries) {
      if (spellsCanonicalId(name) && !Node.isComputedPropertyName(memberNode.getFirstChild())) {
        members.push(`${containerName}::${name}@${memberNode.getStartLineNumber()}`);
      }
    }
  });
  return members.sort();
}

function isThisAccess(node: Node): boolean {
  const isAccess = Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node);
  return isAccess && Node.isThisExpression(node.getExpression());
}

function binderThisMember(assignment: BinaryExpression): readonly string[] {
  const target = assignment.getLeft();
  const symbol = (assignment.compilerNode as BoundNode).symbol;
  const container = symbol?.parent;
  if (!symbol || !container || isModuleLevelExport(target)) return [];
  const name = ts.symbolName(symbol);
  const isCurrentMember =
    container.members?.get(symbol.escapedName) === symbol ||
    container.exports?.get(symbol.escapedName) === symbol;
  const ownerName = thisContainerName(container);
  const isListed =
    isCurrentMember &&
    ownerName !== undefined &&
    !ownerVariableDeclares(container, symbol) &&
    firstThisAssignment(symbol) === assignment.compilerNode &&
    hasLiteralName(target) &&
    spellsCanonicalId(name);
  return isListed ? [`${ownerName}::${name}@${target.getStartLineNumber()}`] : [];
}

function firstThisAssignment(symbol: BoundSymbol): ts.Node | undefined {
  const declarations = symbol.declarations ?? [];
  const declaresOnlyThroughThis = declarations.every((declaration) => {
    const declaringAccess = ts.isBinaryExpression(declaration) ? declaration.left : declaration;
    return (
      (ts.isPropertyAccessExpression(declaringAccess) ||
        ts.isElementAccessExpression(declaringAccess)) &&
      declaringAccess.expression.kind === ts.SyntaxKind.ThisKeyword
    );
  });
  if (!declaresOnlyThroughThis) return undefined;
  return declarations.filter(ts.isBinaryExpression).sort((left, right) => left.pos - right.pos)[0];
}

function hasLiteralName(target: Node): boolean {
  if (!Node.isElementAccessExpression(target)) return true;
  const argument = target.getArgumentExpression();
  return Node.isStringLiteral(argument) || Node.isNumericLiteral(argument);
}

function thisContainerName(container: BoundSymbol): string | undefined {
  const declaration = container.valueDeclaration;
  if (!declaration || !ts.isFunctionExpression(declaration)) {
    return isListableContainer(container) ? ts.symbolName(container) : undefined;
  }
  const owner = declaration.parent;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  const assignsFunction =
    ts.isBinaryExpression(owner) &&
    owner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    owner.right === declaration &&
    ts.isPropertyAccessExpression(owner.left);
  return assignsFunction ? owner.left.name.text : undefined;
}

function ownerVariableDeclares(container: BoundSymbol, member: BoundSymbol): boolean {
  const owner = container.valueDeclaration?.parent;
  if (!owner || !ts.isVariableDeclaration(owner)) return false;
  const ownerSymbol = (owner as ts.Node as BoundNode).symbol;
  return ownerSymbol?.members?.has(member.escapedName) ?? false;
}

function isListableContainer(container: BoundSymbol): boolean {
  const declaration = container.valueDeclaration;
  return (
    declaration !== undefined &&
    (ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAccessExpression(declaration) ||
      ts.isElementAccessExpression(declaration))
  );
}

function assignedPrototypeObject(
  node: Node,
  symbol: BoundSymbol,
): ObjectLiteralExpression | undefined {
  if (ts.symbolName(symbol) !== "prototype") return undefined;
  const assignment = node.getParent();
  if (!Node.isBinaryExpression(assignment)) return undefined;
  const value = assignment.getRight();
  return Node.isObjectLiteralExpression(value) ? value : undefined;
}

function unquoted(name: string): string {
  return name.replace(/^["'`](.*)["'`]$/, "$1");
}

function listedExports(sourceFile: SourceFile): readonly string[] {
  const located = locatedDeclarationsOf(sourceFile);
  return located
    .filter(
      ({ declaration, node }) =>
        declaration.identity.segments.length === 1 && isCommonJsDeclarationNode(node),
    )
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
  const namedSymbols = OverviewTree.walkSymbols(entries.entries).filter(
    (symbol) => OverviewTree.ownName(symbol) !== "",
  );
  expect(located).toHaveLength(namedSymbols.length);
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
        return exportEqualsDeclarations(exported);
      }
      if (aliasesSameNameLocal(exported) || !spellsCanonicalId(exported.getName())) return [];
      return exported
        .getDeclarations()
        .map(declaringAccessOf)
        .filter(isCommonJsDeclarationNode)
        .map((declaration) => `${exported.getName()}@${declaration.getStartLineNumber()}`);
    })
    .sort();
}

function declaringAccessOf(declaration: Node): Node {
  const isThisAssignment =
    Node.isBinaryExpression(declaration) && isThisAccess(declaration.getLeft());
  return isThisAssignment ? declaration.getLeft() : declaration;
}

function exportEqualsDeclarations(exportEquals: Symbol): readonly string[] {
  return exportEquals.getDeclarations().flatMap((assignment) => {
    if (!Node.isBinaryExpression(assignment)) return [];
    const object = rightmostAssignedObject(assignment.getRight());
    if (!object) return [`default@${assignment.getStartLineNumber()}`];
    return object
      .getType()
      .getProperties()
      .flatMap((member) =>
        member
          .getDeclarations()
          .filter(
            (declaration) =>
              declaration.getParent() === object &&
              !Node.isShorthandPropertyAssignment(declaration),
          )
          .map((declaration) => `${member.getName()}@${declaration.getStartLineNumber()}`),
      );
  });
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
