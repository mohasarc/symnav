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
