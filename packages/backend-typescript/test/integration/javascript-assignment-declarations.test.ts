import { describe, expect, it } from "vitest";
import {
  InMemoryFileSystem,
  formatSymbolIdentity,
  type SymbolIdentity,
  type SymbolReference,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

describe("TypeScriptBackend CommonJS export declarations", () => {
  it.each([
    ["exports.foo", "exports.foo = function () { return 1; };\n"],
    ["module.exports.foo", "module.exports.foo = function () { return 1; };\n"],
  ])("resolves %s as a target", async (_form, librarySource) => {
    const { backend, files } = await backendOverSources({ "src/lib.js": librarySource });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "foo"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::foo",
    ]);
  });

  it.each([
    ["exports.foo", "exports.foo = function () { return 1; };\n"],
    ["module.exports.foo", "module.exports.foo = function () { return 1; };\n"],
  ])("finds require and import users of %s", async (_form, librarySource) => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": librarySource,
      "src/required.js": "const lib = require('./lib');\nlib.foo();\nrequire('./lib').foo();\n",
      "src/imported.ts": "import { foo } from './lib';\nexport const value = foo();\n",
    });

    const references = await backend.findReferences(files, identity("src/lib.js", "foo"));

    expect(referenceLocations(references)).toEqual([
      "src/imported.ts:1",
      "src/imported.ts:2",
      "src/required.js:2",
      "src/required.js:3",
    ]);
  });

  it("resolves an element-access export and finds its require users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": 'exports["answer"] = 42;\n',
      "src/required.js":
        "const lib = require('./lib');\nlib.answer;\nrequire('./lib')['answer'];\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "answer"));
    const references = await backend.findReferences(files, identity("src/lib.js", "answer"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::answer",
    ]);
    expect(referenceLocations(references)).toEqual(["src/required.js:2", "src/required.js:3"]);
  });

  it("locates an export assigned in a same-name variable's initializer apart from the variable", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "var app = module.exports.app = function () { return 1; };\napp();\n",
      "src/required.js": "const lib = require('./lib');\nlib.app();\n",
    });
    const variable: SymbolIdentity = {
      file: "src/lib.js",
      segments: [{ name: "app", disambiguator: 1 }],
    };
    const exported: SymbolIdentity = {
      file: "src/lib.js",
      segments: [{ name: "app", disambiguator: 2 }],
    };

    const variableReferences = await backend.findReferences(files, variable);
    const exportReferences = await backend.findReferences(files, exported);

    expect(referenceLocations(variableReferences)).toEqual(["src/lib.js:2"]);
    expect(referenceLocations(exportReferences)).toEqual(["src/required.js:2"]);
  });

  it("locates an export hoisted from a function apart from a same-line same-name nested function", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "function f() { exports.g = 1; function g() { return 2; } return g(); }\n",
      "src/use.js": "const lib = require('./lib');\nlib.g;\n",
    });

    const exportReferences = await backend.findReferences(files, identity("src/lib.js", "g"));
    const nestedReferences = await backend.findReferences(files, identity("src/lib.js", "f", "g"));

    expect(referenceLocations(exportReferences)).toEqual(["src/use.js:2"]);
    expect(referenceLocations(nestedReferences)).toEqual(["src/lib.js:1"]);
  });

  it("locates a function nested in an export's value apart from the same-line same-name export", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "exports.h = function () { function h() { return 2; } return h(); };\n",
      "src/use.js": "const lib = require('./lib');\nlib.h();\n",
    });

    const exportReferences = await backend.findReferences(files, identity("src/lib.js", "h"));
    const nestedReferences = await backend.findReferences(files, identity("src/lib.js", "h", "h"));

    expect(referenceLocations(exportReferences)).toEqual(["src/use.js:2"]);
    expect(referenceLocations(nestedReferences)).toEqual(["src/lib.js:1"]);
  });

  it("pairs exports.foo with its .d.ts twin", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "exports.foo = function () { return 1; };\nexports.first = exports.foo();\n",
      "src/lib.d.ts": "export declare function foo(): number;\n",
      "src/imported.ts": "import { foo } from './lib';\nexport const value = foo();\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.d.ts", "foo"));
    const references = await backend.findReferences(files, identity("src/lib.d.ts", "foo"));

    expect(
      definitions.map((definition) => [
        formatSymbolIdentity(definition.identity),
        definition.pairRole,
      ]),
    ).toEqual([
      ["src/lib.js::foo", "implementation"],
      ["src/lib.d.ts::foo", "declaration"],
    ]);
    expect(referenceLocations(references)).toEqual([
      "src/imported.ts:1",
      "src/imported.ts:2",
      "src/lib.js:2",
    ]);
  });

  it.each([
    ["method", "lib.method"],
    ["property", "lib.property"],
    ["accessor", "lib.accessor"],
    ["dash-key", 'lib["dash-key"]'],
    ["7", "lib[7]"],
    ["computed", "lib.computed"],
  ])(
    "resolves the module.exports object member %s and finds its require users",
    async (name, use) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": [
          "module.exports = {",
          "  method() { return 1; },",
          "  property: 2,",
          "  get accessor() { return 3; },",
          '  "dash-key": 4,',
          "  7: 5,",
          '  ["computed"]: 6,',
          "};",
          "",
        ].join("\n"),
        "src/required.js": `const lib = require('./lib');\n${use};\n`,
      });

      const definitions = await backend.findDefinitions(files, identity("src/lib.js", name));
      const references = await backend.findReferences(files, identity("src/lib.js", name));

      expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
        `src/lib.js::${name}`,
      ]);
      expect(referenceLocations(references)).toEqual(["src/required.js:2"]);
    },
  );

  it.each([
    ["a function", "module.exports = function () { return 1; };\n"],
    ["a local", "function make() { return 1; }\nmodule.exports = make;\n"],
  ])(
    "resolves module.exports assigned %s as default and finds its require and import users",
    async (_value, librarySource) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": librarySource,
        "src/required.js": "const make = require('./lib');\nmake();\n",
        "src/imported.ts": "import make from './lib';\nexport const value = make();\n",
      });

      const definitions = await backend.findDefinitions(files, identity("src/lib.js", "default"));
      const references = await backend.findReferences(files, identity("src/lib.js", "default"));

      expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
        "src/lib.js::default",
      ]);
      expect(referenceLocations(references)).toEqual([
        "src/imported.ts:1",
        "src/imported.ts:1",
        "src/imported.ts:2",
        "src/required.js:1",
        "src/required.js:1",
        "src/required.js:2",
      ]);
    },
  );

  it.each([
    ["a module.exports shorthand member", "module.exports = { helper };\n", ["src/lib.js:2"]],
    [
      "a same-name exports property",
      "exports.helper = helper;\n",
      ["src/lib.js:2", "src/lib.js:2"],
    ],
  ])(
    "finds require and import users of a local exported as %s",
    async (_form, exportSource, exportSiteLocations) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": `function helper() { return 1; }\n${exportSource}`,
        "src/required.js": [
          "const lib = require('./lib');",
          "lib.helper();",
          "const { helper } = require('./lib');",
          "helper();",
          "",
        ].join("\n"),
        "src/imported.ts": "import { helper } from './lib';\nexport const value = helper();\n",
      });

      const references = await backend.findReferences(files, identity("src/lib.js", "helper"));

      expect(referenceLocations(references)).toEqual([
        "src/imported.ts:1",
        "src/imported.ts:2",
        ...exportSiteLocations,
        "src/required.js:2",
        "src/required.js:3",
        "src/required.js:4",
      ]);
    },
  );

  it("finds users of a local re-exported through a CommonJS barrel", async () => {
    const { backend, files } = await backendOverSources({
      "src/functions/gt.js": "const gt = (a, b) => a > b;\nmodule.exports = gt;\n",
      "src/index.js": "const gt = require('./functions/gt');\nmodule.exports = { gt };\n",
      "src/use.js": [
        "const { gt } = require('./index');",
        "gt(1, 2);",
        "const semver = require('./index');",
        "semver.gt(1, 2);",
        "",
      ].join("\n"),
    });

    const references = await backend.findReferences(files, identity("src/functions/gt.js", "gt"));

    expect(referenceLocations(references)).toEqual([
      "src/functions/gt.js:2",
      "src/index.js:1",
      "src/index.js:2",
      "src/use.js:1",
      "src/use.js:2",
      "src/use.js:4",
    ]);
  });

  it("lists callers that reach a CommonJS-exported local through require", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "function helper() { return 1; }\nmodule.exports = { helper };\n",
      "src/use.js": [
        "const { helper } = require('./lib');",
        "const lib = require('./lib');",
        "function direct() { return helper(); }",
        "function member() { return lib.helper(); }",
        "",
      ].join("\n"),
    });

    const callers = await backend.findCallers(files, identity("src/lib.js", "helper"));

    expect(callers.map((edge) => formatSymbolIdentity(edge.symbol.identity))).toEqual([
      "src/use.js::direct",
      "src/use.js::member",
    ]);
  });

  it("pairs a module.exports function with the .d.ts export = declaration", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "module.exports = function () { return 1; };\n",
      "src/lib.d.ts": "declare function make(): number;\nexport = make;\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.d.ts", "make"));

    expect(
      definitions.map((definition) => [
        formatSymbolIdentity(definition.identity),
        definition.pairRole,
      ]),
    ).toEqual([
      ["src/lib.js::default", "implementation"],
      ["src/lib.d.ts::make", "declaration"],
    ]);
  });

  it("resolves an Object.defineProperty export and finds its require users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": 'Object.defineProperty(exports, "answer", { value: 42 });\n',
      "src/required.js":
        "const lib = require('./lib');\nlib.answer;\nconst { answer } = require('./lib');\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "answer"));
    const references = await backend.findReferences(files, identity("src/lib.js", "answer"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::answer",
    ]);
    expect(referenceLocations(references)).toEqual(["src/required.js:2", "src/required.js:3"]);
  });
});

describe("TypeScriptBackend module-level this-property exports", () => {
  it("resolves a this-property exported after the file becomes CommonJS and finds its require users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "exports.a = 1;\nthis.after = 2;\n",
      "src/required.js": "const lib = require('./lib');\nlib.after;\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "after"));
    const references = await backend.findReferences(files, identity("src/lib.js", "after"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::after",
    ]);
    expect(referenceLocations(references)).toEqual(["src/required.js:2"]);
  });
});

describe("TypeScriptBackend expando member declarations", () => {
  it.each([
    ["a function", "function Foo() {}\n"],
    ["a class", "class Foo {}\n"],
    ["a variable", "var Foo = function () {};\n"],
  ])(
    "resolves a prototype member of %s and finds its instance users",
    async (_container, declaration) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": `${declaration}Foo.prototype.bar = function () { return 1; };\nexports.Foo = Foo;\n`,
        "src/use.js": "const { Foo } = require('./lib');\nnew Foo().bar();\n",
      });

      const definitions = await backend.findDefinitions(
        files,
        identity("src/lib.js", "Foo", "bar"),
      );
      const references = await backend.findReferences(files, identity("src/lib.js", "Foo", "bar"));

      expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
        "src/lib.js::Foo::bar",
      ]);
      expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
    },
  );

  it.each([
    ["bar", "bar() { return 1; }", "new Foo().bar();"],
    ["baz", "baz: 2", "new Foo().baz;"],
    ["dash-key", '"dash-key": 3', 'new Foo()["dash-key"];'],
  ])(
    "resolves the prototype object member %s and finds its instance users",
    async (name, member, use) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": `function Foo() {}\nFoo.prototype = {\n  ${member},\n};\nexports.Foo = Foo;\n`,
        "src/use.js": `const { Foo } = require('./lib');\n${use}\n`,
      });

      const definitions = await backend.findDefinitions(files, identity("src/lib.js", "Foo", name));
      const references = await backend.findReferences(files, identity("src/lib.js", "Foo", name));

      expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
        `src/lib.js::Foo::${name}`,
      ]);
      expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
    },
  );

  it.each([
    ["a function", "function Foo() {}\n"],
    ["a class", "class Foo {}\n"],
  ])("resolves a static member of %s and finds its users", async (_container, declaration) => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": `${declaration}Foo.make = function () { return 1; };\nexports.Foo = Foo;\n`,
      "src/use.js": "const { Foo } = require('./lib');\nFoo.make();\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "Foo", "make"));
    const references = await backend.findReferences(files, identity("src/lib.js", "Foo", "make"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::Foo::make",
    ]);
    expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
  });

  it.each([
    ["a class expression method", "var A = class { m() {} }; A.m = function () {};"],
    ["a class expression static method", "var A = class { static m() {} }; A.m = function () {};"],
    ["a later object literal method", "A.m = function () {}; function A() {} var o = { m() {} };"],
  ])(
    "locates a static member apart from %s with the same name on its line",
    async (_neighbour, declaration) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": `${declaration}\nA.m();\nnew A().m();\nexports.A = A;\n`,
      });

      const references = await backend.findReferences(files, identity("src/lib.js", "A", "m"));

      expect(referenceLocations(references)).toEqual(["src/lib.js:2"]);
    },
  );

  it("locates functions nested in an unnamed default export next to a same-line expando member", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js":
        "export default function () { function Foo() {} Foo.x = 1; function x() {} x(); }\n",
    });
    const nested: SymbolIdentity = { file: "src/lib.js", segments: [{ name: "" }, { name: "x" }] };
    const member: SymbolIdentity = {
      file: "src/lib.js",
      segments: [{ name: "" }, { name: "Foo" }, { name: "x" }],
    };

    const nestedReferences = await backend.findReferences(files, nested);
    const memberDefinitions = await backend.findDefinitions(files, member);

    expect(referenceLocations(nestedReferences)).toEqual(["src/lib.js:1"]);
    expect(
      memberDefinitions.map((definition) => formatSymbolIdentity(definition.identity)),
    ).toEqual(["src/lib.js::::Foo::x"]);
  });

  it("resolves an Object.defineProperty member of a function and finds its users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js":
        'function Foo() {}\nObject.defineProperty(Foo, "make", { value: function () { return 1; } });\nexports.Foo = Foo;\n',
      "src/use.js": "const { Foo } = require('./lib');\nFoo.make();\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "Foo", "make"));
    const references = await backend.findReferences(files, identity("src/lib.js", "Foo", "make"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::Foo::make",
    ]);
    expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
  });

  it.each([
    [
      "an empty object",
      "const ns = {};\nns.helper = function () { return 1; };\nexports.ns = ns;\n",
    ],
    [
      "a CommonJS export",
      "exports.ns = function () {};\nexports.ns.helper = function () { return 1; };\n",
    ],
  ])(
    "resolves a namespace member of %s and finds its require users",
    async (_container, librarySource) => {
      const { backend, files } = await backendOverSources({
        "src/lib.js": librarySource,
        "src/use.js": "const lib = require('./lib');\nlib.ns.helper();\n",
      });

      const definitions = await backend.findDefinitions(
        files,
        identity("src/lib.js", "ns", "helper"),
      );
      const references = await backend.findReferences(
        files,
        identity("src/lib.js", "ns", "helper"),
      );

      expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
        "src/lib.js::ns::helper",
      ]);
      expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
    },
  );
});

describe("TypeScriptBackend this-property member declarations", () => {
  it("resolves a class constructor this-property and finds its instance users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js":
        "class Foo {\n  constructor() {\n    this.count = 0;\n  }\n  bump() {\n    this.count = this.count + 1;\n  }\n}\nexports.Foo = Foo;\n",
      "src/use.js": "const { Foo } = require('./lib');\nnew Foo().count;\n",
    });

    const definitions = await backend.findDefinitions(
      files,
      identity("src/lib.js", "Foo", "count"),
    );
    const references = await backend.findReferences(files, identity("src/lib.js", "Foo", "count"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::Foo::count",
    ]);
    expect(referenceLocations(references)).toEqual(["src/lib.js:6", "src/use.js:2"]);
  });

  it.each([
    ["a constructor function", "function Foo() {\n  this.value = 1;\n}\n"],
    ["a function expression", "var Foo = function () {\n  this.value = 1;\n};\n"],
    ["a parenthesized function expression", "var Foo = (function () {\n  this.value = 1;\n});\n"],
    [
      "a prototype method",
      "function Foo() {}\nFoo.prototype.init = function () {\n  this.value = 1;\n};\n",
    ],
  ])("resolves a this-property of %s and finds its instance users", async (_container, source) => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": `${source}exports.Foo = Foo;\n`,
      "src/use.js": "const { Foo } = require('./lib');\nnew Foo().value;\n",
    });

    const definitions = await backend.findDefinitions(
      files,
      identity("src/lib.js", "Foo", "value"),
    );
    const references = await backend.findReferences(files, identity("src/lib.js", "Foo", "value"));

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::Foo::value",
    ]);
    expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
  });

  it("resolves a static method this-property and finds its static users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js":
        "class Foo {\n  static init() {\n    this.shared = {};\n  }\n}\nexports.Foo = Foo;\n",
      "src/use.js": "const { Foo } = require('./lib');\nFoo.shared;\n",
    });

    const references = await backend.findReferences(files, identity("src/lib.js", "Foo", "shared"));

    expect(referenceLocations(references)).toEqual(["src/use.js:2"]);
  });
});

describe("TypeScriptBackend JSDoc type alias declarations", () => {
  it("resolves @typedef and @callback targets and finds their import type users", async () => {
    const { backend, files } = await backendOverSources({
      "src/types.js":
        "/**\n * @typedef {Object} Shape\n * @property {number} width\n */\n/**\n * @callback Visit\n * @param {Shape} shape\n */\nexports.q = 1;\n",
      "src/use.js":
        "/** @type {import('./types.js').Shape} */\nconst shape = null;\n/** @param {import('./types').Visit} visit */\nfunction walk(visit) {}\n",
      "src/use.ts": "import type { Shape } from './types';\nexport let shape: Shape;\n",
    });

    const shapeDefinitions = await backend.findDefinitions(
      files,
      identity("src/types.js", "Shape"),
    );
    const shapeReferences = await backend.findReferences(files, identity("src/types.js", "Shape"));
    const visitReferences = await backend.findReferences(files, identity("src/types.js", "Visit"));

    expect(shapeDefinitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual(
      ["src/types.js::Shape"],
    );
    expect(referenceLocations(shapeReferences)).toEqual([
      "src/types.js:7",
      "src/use.js:1",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
    expect(referenceLocations(visitReferences)).toEqual(["src/use.js:3"]);
  });

  it("resolves an @enum variable and finds its value and type users", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js": "/** @enum {number} */\nexport const Color = { Red: 1 };\n",
      "src/use.js":
        "import { Color } from './lib.js';\n/** @type {Color} */\nexport let color = Color.Red;\n",
    });

    const definitions = await backend.findDefinitions(files, identity("src/lib.js", "Color"));
    const references = await backend.findReferences(files, identity("src/lib.js", "Color"));

    expect(
      definitions.map((definition) => [
        formatSymbolIdentity(definition.identity),
        definition.kind.nativeLabel,
      ]),
    ).toEqual([["src/lib.js::Color", "enum"]]);
    expect(referenceLocations(references)).toEqual([
      "src/use.js:1",
      "src/use.js:2",
      "src/use.js:3",
    ]);
  });

  it("resolves a @typedef scoped to a function body and finds its users there", async () => {
    const { backend, files } = await backendOverSources({
      "src/lib.js":
        "function outer() {\n  /** @typedef {string} Inner */\n  /** @type {Inner} */\n  const value = '';\n}\n",
    });

    const definitions = await backend.findDefinitions(
      files,
      identity("src/lib.js", "outer", "Inner"),
    );
    const references = await backend.findReferences(
      files,
      identity("src/lib.js", "outer", "Inner"),
    );

    expect(definitions.map((definition) => formatSymbolIdentity(definition.identity))).toEqual([
      "src/lib.js::outer::Inner",
    ]);
    expect(referenceLocations(references)).toEqual(["src/lib.js:3"]);
  });
});

async function backendOverSources(sources: Readonly<Record<string, string>>): Promise<{
  readonly backend: TypeScriptBackend;
  readonly files: readonly WorkspaceFile[];
}> {
  const fileSystem = new InMemoryFileSystem(
    Object.fromEntries(
      Object.entries(sources).map(([relativePath, content]) => [`/repo/${relativePath}`, content]),
    ),
  );
  const files = Object.keys(sources)
    .sort()
    .map((relativePath) => ({
      relative: relativePath,
      absolute: `/repo/${relativePath}`,
      metadata: fileSystem.metadataSync(`/repo/${relativePath}`),
    }));
  const backend = new TypeScriptBackend(fileSystem);
  await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });
  return { backend, files };
}

function referenceLocations(references: readonly SymbolReference[]): readonly string[] {
  return references.map((reference) => `${reference.file}:${reference.line}`).sort();
}

function identity(file: string, ...names: readonly string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}
