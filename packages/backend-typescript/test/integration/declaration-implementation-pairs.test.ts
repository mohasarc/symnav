import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import {
  InMemoryFileSystem,
  NodeFileSystem,
  formatSymbolIdentity,
  type DefinitionPairRole,
  type DefinitionSymbol,
  type SymbolIdentity,
  type SymbolReference,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

const pairFixtureRoot = fixturePath("javascript-pair-cases").replaceAll("\\", "/");

describe("TypeScriptBackend declaration and implementation pairs", () => {
  it("includes uses bound to the .d.ts twin in references of a JavaScript default-export local", async () => {
    const { backend, files } = await backendOverPairFixture();

    const references = await backend.findReferences(files, identity("src/Tabs/Tabs.js", "Tabs"));
    const distinctMatches = new Set(
      references.map((reference) => `${reference.file}:${reference.line}:${reference.matchStart}`),
    );

    expect(distinctMatches.size).toBe(references.length);
    expect(referenceLocations(references)).toEqual([
      "src/App.tsx:1",
      "src/App.tsx:4",
      "src/Tabs/Tabs.d.ts:7",
      "src/Tabs/Tabs.js:10",
      "src/Tabs/index.d.ts:1",
      "src/Tabs/index.js:1",
      "src/hooks/useTabs.js:1",
      "src/hooks/useTabs.js:2",
      "src/hooks/useTabs.js:5",
      "src/hooks/useTabs.js:5",
    ]);
  });

  it("links a JavaScript value to the .d.ts const behind a merged interface declared first", async () => {
    const { backend, files } = await backendOverSources(interfaceFirstSources);

    const references = await backend.findReferences(files, identity("src/foo.js", "Foo"));

    expect(referenceLocations(references)).toEqual([
      "src/foo.js:2",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
  });

  it("links a JavaScript function to the .d.ts function, not a type-only namespace merged with it", async () => {
    const { backend, files } = await backendOverSources(typeOnlyNamespaceSources);

    const references = await backend.findReferences(files, identity("src/foo.js", "foo"));

    expect(referenceLocations(references)).toEqual([
      "src/foo.js:2",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
  });

  it("includes JavaScript in-file uses in references of a .d.ts declaration", async () => {
    const { backend, files } = await backendOverPairFixture();

    const references = await backend.findReferences(files, identity("src/Tabs/Tabs.d.ts", "Tabs"));

    expect(referenceLocations(references)).toEqual([
      "src/App.tsx:1",
      "src/App.tsx:4",
      "src/Tabs/Tabs.d.ts:7",
      "src/Tabs/Tabs.js:10",
      "src/Tabs/index.d.ts:1",
      "src/Tabs/index.js:1",
      "src/hooks/useTabs.js:1",
      "src/hooks/useTabs.js:2",
      "src/hooks/useTabs.js:5",
      "src/hooks/useTabs.js:5",
    ]);
  });

  it("links a .d.ts const to its JavaScript twin but not the interface merged before it", async () => {
    const { backend, files } = await backendOverSources(interfaceFirstSources);
    const interfaceDeclaration: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "Foo", disambiguator: 1 }],
    };
    const constDeclaration: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "Foo", disambiguator: 2 }],
    };

    const interfaceReferences = await backend.findReferences(files, interfaceDeclaration);
    const constReferences = await backend.findReferences(files, constDeclaration);

    expect(referenceLocations(interfaceReferences)).toEqual(["src/use.ts:1", "src/use.ts:3"]);
    expect(referenceLocations(constReferences)).toEqual([
      "src/foo.js:2",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
  });

  it("links a .d.ts function to its JavaScript twin but not the type-only namespace merged with it", async () => {
    const { backend, files } = await backendOverSources(typeOnlyNamespaceSources);
    const functionDeclaration: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "foo", disambiguator: 1 }],
    };
    const namespaceDeclaration: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "foo", disambiguator: 2 }],
    };

    const functionReferences = await backend.findReferences(files, functionDeclaration);
    const namespaceReferences = await backend.findReferences(files, namespaceDeclaration);

    expect(referenceLocations(functionReferences)).toEqual([
      "src/foo.js:2",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
    expect(referenceLocations(namespaceReferences)).toEqual(["src/use.ts:1", "src/use.ts:3"]);
  });

  it("includes JavaScript uses in references of a bare .d.ts target naming a merged family", async () => {
    const { backend, files } = await backendOverSources(interfaceFirstSources);

    const references = await backend.findReferences(files, identity("src/foo.d.ts", "Foo"));

    expect(referenceLocations(references)).toEqual([
      "src/foo.js:2",
      "src/use.ts:1",
      "src/use.ts:2",
      "src/use.ts:3",
    ]);
  });

  it.each([
    ["src/Tabs.jsx", "src/Tabs.d.ts", "./Tabs"],
    ["src/Tabs/index.js", "src/Tabs/index.d.ts", "./Tabs"],
    ["src/tabs.mjs", "src/tabs.d.mts", "./tabs.mjs"],
    ["src/tabs.cjs", "src/tabs.d.cts", "./tabs.cjs"],
  ])(
    "merges references across %s and %s from either side",
    async (implementationFile, declarationFile, specifier) => {
      const { backend, files } = await backendOverSources({
        [implementationFile]:
          "export function tabs() { return 1; }\nexport const first = tabs();\n",
        [declarationFile]: "export declare function tabs(): number;\n",
        "src/use.ts": `import { tabs } from "${specifier}";\nexport const value = tabs();\n`,
      });
      const expected = [`${implementationFile}:2`, "src/use.ts:1", "src/use.ts:2"].sort();

      const fromImplementation = await backend.findReferences(
        files,
        identity(implementationFile, "tabs"),
      );
      const fromDeclaration = await backend.findReferences(
        files,
        identity(declarationFile, "tabs"),
      );

      expect(referenceLocations(fromImplementation)).toEqual(expected);
      expect(referenceLocations(fromDeclaration)).toEqual(expected);
    },
  );

  it("pairs a .d.ts nothing imports with its JavaScript twin", async () => {
    const { backend, files } = await backendOverSources({
      "src/lone.js": "export function lone() { return 1; }\nexport const first = lone();\n",
      "src/lone.d.ts": "export declare function lone(): number;\n",
    });

    const references = await backend.findReferences(files, identity("src/lone.d.ts", "lone"));

    expect(referenceLocations(references)).toEqual(["src/lone.js:2"]);
  });

  it("keeps a .d.ts without a JavaScript twin unpaired", async () => {
    const { backend, files } = await backendOverSources({
      "src/types.d.ts": "export declare function only(): number;\n",
      "src/use.ts": 'import { only } from "./types";\nexport const value = only();\n',
    });

    const references = await backend.findReferences(files, identity("src/types.d.ts", "only"));

    expect(referenceLocations(references)).toEqual(["src/use.ts:1", "src/use.ts:2"]);
  });

  it("does not pair JavaScript with a TypeScript source of the same name", async () => {
    const { backend, files } = await backendOverSources({
      "src/X.ts": "export function x(): number { return 1; }\n",
      "src/X.js": "export function x() { return 2; }\nexport const first = x();\n",
      "src/use.ts": 'import { x } from "./X";\nexport const value = x();\n',
    });

    const javaScriptReferences = await backend.findReferences(files, identity("src/X.js", "x"));
    const typeScriptReferences = await backend.findReferences(files, identity("src/X.ts", "x"));

    expect(referenceLocations(javaScriptReferences)).toEqual(["src/X.js:2"]);
    expect(referenceLocations(typeScriptReferences)).toEqual(["src/use.ts:1", "src/use.ts:2"]);
  });

  it("pairs a .d.ts and JavaScript an importer reaches through one paths mapping", async () => {
    const { backend, files } = await backendOverSources({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { allowJs: true, baseUrl: ".", paths: { "@ui/*": ["types/*", "lib/*"] } },
      }),
      "types/button.d.ts": "export declare function button(): number;\n",
      "lib/button.js": "export function button() { return 1; }\nexport const first = button();\n",
      "src/app.ts": 'import { button } from "@ui/button";\nexport const value = button();\n',
    });
    const expected = ["lib/button.js:2", "src/app.ts:1", "src/app.ts:2"];

    const fromImplementation = await backend.findReferences(
      files,
      identity("lib/button.js", "button"),
    );
    const fromDeclaration = await backend.findReferences(
      files,
      identity("types/button.d.ts", "button"),
    );

    expect(referenceLocations(fromImplementation)).toEqual(expected);
    expect(referenceLocations(fromDeclaration)).toEqual(expected);
  });

  it("pairs the types and main entries of a workspace package an importer reaches", async () => {
    const { backend, files } = await backendOverSources({
      "packages/ui/package.json": JSON.stringify({
        name: "@workspace/ui",
        types: "index.d.ts",
        main: "index.js",
      }),
      "packages/ui/index.d.ts": "export declare function button(): number;\n",
      "packages/ui/index.js":
        "export function button() { return 1; }\nexport const first = button();\n",
      "src/app.ts": 'import { button } from "@workspace/ui";\nexport const value = button();\n',
    });

    const references = await backend.findReferences(
      files,
      identity("packages/ui/index.js", "button"),
    );

    expect(referenceLocations(references)).toEqual([
      "packages/ui/index.js:2",
      "src/app.ts:1",
      "src/app.ts:2",
    ]);
  });

  it("keeps a JavaScript export the .d.ts does not declare unpaired", async () => {
    const { backend, files } = await backendOverPairFixture();

    const references = await backend.findReferences(files, identity("src/Tabs/Tabs.js", "styles"));

    expect(referenceLocations(references)).toEqual(["src/Tabs/Tabs.js:10"]);
  });

  it("keeps a JavaScript value unpaired from a type-only .d.ts export of the same name", async () => {
    const { backend, files } = await backendOverSources({
      "src/foo.js": "export const Opts = { a: 1 };\nexport const first = Opts.a;\n",
      "src/foo.d.ts": "export interface Opts {\n  a: number;\n}\n",
      "src/use.ts": 'import type { Opts } from "./foo";\nexport let typed: Opts | undefined;\n',
    });

    const implementationReferences = await backend.findReferences(
      files,
      identity("src/foo.js", "Opts"),
    );
    const declarationReferences = await backend.findReferences(
      files,
      identity("src/foo.d.ts", "Opts"),
    );

    expect(referenceLocations(implementationReferences)).toEqual(["src/foo.js:2"]);
    expect(referenceLocations(declarationReferences)).toEqual(["src/use.ts:1", "src/use.ts:2"]);
  });

  it.each([
    [
      "an aliased JavaScript export",
      "function local() { return 1; }\nexport { local as tabs };\nexport const first = local();\n",
      "export declare function tabs(): number;\n",
      identity("src/tabs.js", "local"),
      ["src/tabs.js:2", "src/tabs.js:2", "src/tabs.js:3", "src/use.ts:1", "src/use.ts:2"],
    ],
    [
      "an aliased .d.ts export",
      "export function tabs() { return 1; }\nexport const first = tabs();\n",
      "declare function local(): number;\nexport { local as tabs };\n",
      identity("src/tabs.d.ts", "local"),
      ["src/tabs.d.ts:2", "src/tabs.d.ts:2", "src/tabs.js:2", "src/use.ts:1", "src/use.ts:2"],
    ],
  ])(
    "links locals behind %s by export name",
    async (_case, implementationSource, declarationSource, target, expected) => {
      const { backend, files } = await backendOverSources({
        "src/tabs.js": implementationSource,
        "src/tabs.d.ts": declarationSource,
        "src/use.ts": 'import { tabs } from "./tabs";\nexport const value = tabs();\n',
      });

      const references = await backend.findReferences(files, target);

      expect(referenceLocations(references)).toEqual(expected);
    },
  );

  it("links every overload of a .d.ts function to its JavaScript twin", async () => {
    const { backend, files } = await backendOverSources({
      "src/tabs.js": "export function tabs(x) { return 1; }\nexport const first = tabs();\n",
      "src/tabs.d.ts":
        "export declare function tabs(): number;\nexport declare function tabs(x: number): number;\n",
    });
    const secondOverload: SymbolIdentity = {
      file: "src/tabs.d.ts",
      segments: [{ name: "tabs", disambiguator: 2 }],
    };

    const references = await backend.findReferences(files, secondOverload);

    expect(referenceLocations(references)).toEqual(["src/tabs.js:2"]);
  });

  it("links a bare .d.ts target naming an overload family to its JavaScript twin", async () => {
    const { backend, files } = await backendOverSources(overloadedDeclarationSources);

    const references = await backend.findReferences(files, identity("src/tabs.d.ts", "tabs"));

    expect(referenceLocations(references)).toEqual([
      "src/tabs.js:2",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
  });

  it("links class members of a pair by member name", async () => {
    const { backend, files } = await backendOverSources({
      "src/tabs.js":
        "export class Tabs {\n  render() { return 1; }\n  first() { return this.render(); }\n}\n",
      "src/tabs.d.ts": "export declare class Tabs {\n  render(): number;\n  first(): number;\n}\n",
      "src/use.ts": 'import { Tabs } from "./tabs";\nexport const value = new Tabs().render();\n',
    });
    const expected = ["src/tabs.js:3", "src/use.ts:2"];

    const fromImplementation = await backend.findReferences(
      files,
      identity("src/tabs.js", "Tabs", "render"),
    );
    const fromDeclaration = await backend.findReferences(
      files,
      identity("src/tabs.d.ts", "Tabs", "render"),
    );

    expect(referenceLocations(fromImplementation)).toEqual(expected);
    expect(referenceLocations(fromDeclaration)).toEqual(expected);
  });

  it("links a JavaScript static member to a .d.ts namespace member merged with the class", async () => {
    const { backend, files } = await backendOverSources({
      "src/foo.js":
        "export class Foo {\n  static create() { return new Foo(); }\n}\nexport const first = Foo.create();\n",
      "src/foo.d.ts":
        "export declare class Foo {}\nexport declare namespace Foo {\n  function create(): Foo;\n}\n",
      "src/use.ts": 'import { Foo } from "./foo";\nexport const value = Foo.create();\n',
    });
    const namespaceMember: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "Foo", disambiguator: 2 }, { name: "create" }],
    };
    const expected = ["src/foo.js:4", "src/use.ts:2"];

    const fromImplementation = await backend.findReferences(
      files,
      identity("src/foo.js", "Foo", "create"),
    );
    const fromDeclaration = await backend.findReferences(files, namespaceMember);

    expect(referenceLocations(fromImplementation)).toEqual(expected);
    expect(referenceLocations(fromDeclaration)).toEqual(expected);
  });

  it("links static and instance members of a pair separately", async () => {
    const { backend, files } = await backendOverSources(staticAndInstanceSources);
    const staticImplementation: SymbolIdentity = {
      file: "src/foo.js",
      segments: [{ name: "Foo" }, { name: "x", disambiguator: 1 }],
    };
    const instanceDeclaration: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "Foo" }, { name: "x", disambiguator: 2 }],
    };

    const staticReferences = await backend.findReferences(files, staticImplementation);
    const instanceReferences = await backend.findReferences(files, instanceDeclaration);

    expect(referenceLocations(staticReferences)).toEqual(["src/foo.js:5", "src/use.ts:2"]);
    expect(referenceLocations(instanceReferences)).toEqual(["src/foo.js:6", "src/use.ts:3"]);
  });

  it("lists a require caller among the callers of a CommonJS export paired with export =", async () => {
    const { backend, files } = await backendOverPairFixture();

    const callers = await backend.findCallers(files, identity("src/cjs/util.js", "helper"));

    expect(callers.map((edge) => edge.symbol.identity)).toEqual([
      identity("src/cjs/consumer.js", "run"),
    ]);
  });

  it("links an export = namespace member to its CommonJS export, not the namespace", async () => {
    const { backend, files } = await backendOverPairFixture();

    const memberReferences = await backend.findReferences(
      files,
      identity("src/cjs/util.d.ts", "util", "helper"),
    );
    const namespaceReferences = await backend.findReferences(
      files,
      identity("src/cjs/util.d.ts", "util"),
    );

    expect(referenceLocations(memberReferences)).toEqual([
      "src/cjs/consumer.js:4",
      "src/cjs/util.js:5",
    ]);
    expect(referenceLocations(namespaceReferences)).toEqual([
      "src/cjs/consumer.js:1",
      "src/cjs/consumer.js:4",
      "src/cjs/util.d.ts:5",
    ]);
  });

  it.each([
    ["export =", "export = Foo;", 'import Foo = require("./foo");'],
    ["export default", "export default Foo;", 'import Foo from "./foo";'],
  ])(
    "links a module.exports class to a .d.ts %s class",
    async (_case, declarationExport, importStatement) => {
      const { backend, files } = await backendOverSources({
        "src/foo.js": "class Foo {\n  run() { return 1; }\n}\nmodule.exports = Foo;\n",
        "src/foo.d.ts": `declare class Foo {\n  run(): number;\n}\n${declarationExport}\n`,
        "src/use.ts": `${importStatement}\nexport const value = new Foo().run();\n`,
      });

      const classReferences = await backend.findReferences(files, identity("src/foo.js", "Foo"));
      const memberReferences = await backend.findReferences(
        files,
        identity("src/foo.js", "Foo", "run"),
      );

      expect(referenceLocations(classReferences)).toEqual([
        "src/foo.d.ts:4",
        "src/foo.js:4",
        "src/use.ts:1",
        "src/use.ts:2",
      ]);
      expect(referenceLocations(memberReferences)).toEqual(["src/use.ts:2"]);
    },
  );

  it("links the local class a wrapped module.exports expression references", async () => {
    const { backend, files } = await backendOverSources({
      "src/foo.js":
        "class Foo {\n  run() { return 1; }\n}\nconst wrap = (c) => c;\nmodule.exports = wrap(Foo);\n",
      "src/foo.d.ts": "declare class Foo {\n  run(): number;\n}\nexport = Foo;\n",
      "src/use.ts": 'import Foo = require("./foo");\nexport const value = new Foo().run();\n',
    });

    const references = await backend.findReferences(files, identity("src/foo.js", "Foo"));

    expect(referenceLocations(references)).toEqual([
      "src/foo.d.ts:4",
      "src/foo.js:5",
      "src/use.ts:1",
      "src/use.ts:2",
    ]);
  });

  it("merges references across a configured .d.ts and inferred JavaScript twin", async () => {
    const { backend, files } = await backendOverSources({
      "tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
      "src/tabs.js": "export function tabs() { return 1; }\nexport const first = tabs();\n",
      "src/tabs.d.ts": "export declare function tabs(): number;\n",
      "src/use.ts": 'import { tabs } from "./tabs";\nexport const value = tabs();\n',
    });
    const expected = ["src/tabs.js:2", "src/use.ts:1", "src/use.ts:2"];

    const fromImplementation = await backend.findReferences(files, identity("src/tabs.js", "tabs"));
    const fromDeclaration = await backend.findReferences(files, identity("src/tabs.d.ts", "tabs"));

    expect(referenceLocations(fromImplementation)).toEqual(expected);
    expect(referenceLocations(fromDeclaration)).toEqual(expected);
  });
});

describe("TypeScriptBackend definitions of declaration and implementation pairs", () => {
  it.each(["src/Tabs/Tabs.js", "src/Tabs/Tabs.d.ts"])(
    "lists both halves of the Tabs pair from %s, tagged by pair role",
    async (file) => {
      const { backend, files } = await backendOverPairFixture();

      const definitions = await backend.findDefinitions(files, identity(file, "Tabs"));

      expect(definitionRoles(definitions)).toEqual([
        ["src/Tabs/Tabs.js::Tabs", "implementation"],
        ["src/Tabs/Tabs.d.ts::Tabs", "declaration"],
      ]);
    },
  );

  it("tags every overload of a bare .d.ts target as the declaration half", async () => {
    const { backend, files } = await backendOverSources(overloadedDeclarationSources);

    const definitions = await backend.findDefinitions(files, identity("src/tabs.d.ts", "tabs"));

    expect(definitionRoles(definitions)).toEqual([
      ["src/tabs.js::tabs", "implementation"],
      ["src/tabs.d.ts::tabs#1", "declaration"],
      ["src/tabs.d.ts::tabs#2", "declaration"],
    ]);
  });

  it.each([
    ["src/Tabs/Tabs.d.ts", ["Tabs"], "src/Tabs/Tabs.js::Tabs"],
    ["src/cjs/util.d.ts", ["util", "helper"], "src/cjs/util.js::helper"],
  ])(
    "resolves the call target of %s %j to its JavaScript implementation",
    async (file, names, expected) => {
      const { backend, files } = await backendOverPairFixture();

      const resolution = await backend.findCallTarget(files, identity(file, ...names));

      expect(resolution.outcome).toBe("resolved");
      expect(
        resolution.outcome === "resolved" && formatSymbolIdentity(resolution.target.identity),
      ).toBe(expected);
    },
  );

  it("lists only the same-staticness member of the other half", async () => {
    const { backend, files } = await backendOverSources(staticAndInstanceSources);
    const staticDeclaration: SymbolIdentity = {
      file: "src/foo.d.ts",
      segments: [{ name: "Foo" }, { name: "x", disambiguator: 1 }],
    };

    const definitions = await backend.findDefinitions(files, staticDeclaration);
    const resolution = await backend.findCallTarget(files, staticDeclaration);

    expect(definitionRoles(definitions)).toEqual([
      ["src/foo.js::Foo::x#1", "implementation"],
      ["src/foo.d.ts::Foo::x#1", "declaration"],
    ]);
    expect(
      resolution.outcome === "resolved" && formatSymbolIdentity(resolution.target.identity),
    ).toBe("src/foo.js::Foo::x#1");
  });

  it("leaves definitions outside a pair link untagged", async () => {
    const { backend, files } = await backendOverPairFixture();

    const unpairedExport = await backend.findDefinitions(
      files,
      identity("src/Tabs/Tabs.js", "styles"),
    );
    const declarationOnlyExport = await backend.findDefinitions(
      files,
      identity("src/Tabs/Tabs.d.ts", "TabsProps"),
    );

    expect(definitionRoles(unpairedExport)).toEqual([["src/Tabs/Tabs.js::styles", undefined]]);
    expect(definitionRoles(declarationOnlyExport)).toEqual([
      ["src/Tabs/Tabs.d.ts::TabsProps", undefined],
    ]);
  });
});

const interfaceFirstSources: Readonly<Record<string, string>> = {
  "src/foo.js": "export const Foo = () => 1;\nexport const first = Foo();\n",
  "src/foo.d.ts":
    "export interface Foo {\n  a: number;\n}\nexport declare const Foo: () => number;\n",
  "src/use.ts":
    'import { Foo } from "./foo";\nexport const value = Foo();\nexport let typed: Foo | undefined;\n',
};

const typeOnlyNamespaceSources: Readonly<Record<string, string>> = {
  "src/foo.js": "export function foo() { return 1; }\nexport const first = foo();\n",
  "src/foo.d.ts":
    "export declare function foo(): number;\nexport declare namespace foo {\n  interface Opts {\n    a: number;\n  }\n}\n",
  "src/use.ts":
    'import { foo } from "./foo";\nexport const value = foo();\nexport let typed: foo.Opts | undefined;\n',
};

const overloadedDeclarationSources: Readonly<Record<string, string>> = {
  "src/tabs.js": "export function tabs(x) { return 1; }\nexport const first = tabs();\n",
  "src/tabs.d.ts":
    "export declare function tabs(): number;\nexport declare function tabs(x: number): number;\n",
  "src/use.ts": 'import { tabs } from "./tabs";\nexport const value = tabs();\n',
};

const staticAndInstanceSources: Readonly<Record<string, string>> = {
  "src/foo.js":
    "export class Foo {\n  static x() { return 1; }\n  x() { return 2; }\n}\nexport const first = Foo.x();\nexport const second = new Foo().x();\n",
  "src/foo.d.ts": "export declare class Foo {\n  static x(): number;\n  x(): number;\n}\n",
  "src/use.ts":
    'import { Foo } from "./foo";\nexport const viaClass = Foo.x();\nexport const viaInstance = new Foo().x();\n',
};

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
    .filter((relativePath) => !relativePath.endsWith(".json"))
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

async function backendOverPairFixture(): Promise<{
  readonly backend: TypeScriptBackend;
  readonly files: readonly WorkspaceFile[];
}> {
  const fileSystem = new NodeFileSystem();
  const files = await Promise.all(
    fixtureSourcePaths(pairFixtureRoot).map(async (absolute) => ({
      relative: relative(pairFixtureRoot, absolute).replaceAll("\\", "/"),
      absolute,
      metadata: await fileSystem.metadata(absolute),
    })),
  );
  const backend = new TypeScriptBackend(fileSystem);
  await backend.refresh({ snapshot: { root: pairFixtureRoot, files }, coverage: "workspace" });
  return { backend, files };
}

function fixtureSourcePaths(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) return entry.name === "dot-git" ? [] : fixtureSourcePaths(absolute);
      return entry.name.endsWith(".json") ? [] : [absolute];
    })
    .sort();
}

function referenceLocations(references: readonly SymbolReference[]): readonly string[] {
  return references.map((reference) => `${reference.file}:${reference.line}`).sort();
}

function definitionRoles(
  definitions: readonly DefinitionSymbol[],
): readonly (readonly [string, DefinitionPairRole | undefined])[] {
  return definitions.map((definition) => [
    formatSymbolIdentity(definition.identity),
    definition.pairRole,
  ]);
}

function identity(file: string, ...names: readonly string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}
