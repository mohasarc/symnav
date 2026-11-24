import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import {
  InMemoryFileSystem,
  NodeFileSystem,
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

function identity(file: string, name: string): SymbolIdentity {
  return { file, segments: [{ name }] };
}
