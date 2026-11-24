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
      expect(referenceLocations(references)).toEqual(["src/imported.ts:1", "src/required.js:1"]);
    },
  );
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
