import { describe, expect, it } from "vitest";

import { ModuleImporterIndex, type ModuleResolutionScope } from "./module-importer-index.js";
import { WorkspacePathDialect } from "./workspace-path-dialect.js";

const ROOT = "/repo";
const NO_MAPPING_SCOPE: ModuleResolutionScope = { baseUrl: undefined, paths: {} };

function reachingFiles(input: {
  readonly sources: Readonly<Record<string, string>>;
  readonly target: string;
  readonly scope?: ModuleResolutionScope;
  readonly packageDirectories?: readonly string[];
}): readonly string[] {
  const index = new ModuleImporterIndex({
    paths: new WorkspacePathDialect(ROOT),
    sources: Object.entries(input.sources).map(([relative, text]) => ({
      absolute: `${ROOT}/${relative}`,
      text,
    })),
    packageDirectories: (input.packageDirectories ?? []).map((relative) => `${ROOT}/${relative}`),
  });
  return [...index.filesReaching(`${ROOT}/${input.target}`, input.scope ?? NO_MAPPING_SCOPE)]
    .map((absolute) => absolute.slice(ROOT.length + 1))
    .sort();
}

describe("ModuleImporterIndex", () => {
  it("links a relative import with or without a module extension", () => {
    expect(
      reachingFiles({
        sources: {
          "core/a.ts": "export const a = 1;\n",
          "app/plain.ts": 'import { a } from "../core/a";\n',
          "app/suffixed.ts": "import { a } from '../core/a.js';\n",
          "app/other.ts": 'import { b } from "../core/b";\n',
        },
        target: "core/a.ts",
      }),
    ).toEqual(["app/plain.ts", "app/suffixed.ts", "core/a.ts"]);
  });

  it("links an import through every file that re-exports the target", () => {
    expect(
      reachingFiles({
        sources: {
          "core/a.ts": "export const a = 1;\n",
          "core/bridge.ts": 'export * from "./a";\n',
          "app/use.ts": 'import { a } from "../core/bridge";\n',
        },
        target: "core/a.ts",
      }),
    ).toEqual(["app/use.ts", "core/a.ts", "core/bridge.ts"]);
  });

  it("links a template literal dynamic import", () => {
    expect(
      reachingFiles({
        sources: {
          "core/a.ts": "export const a = 1;\n",
          "app/use.ts": "export const loaded = import(`../core/a`);\n",
        },
        target: "core/a.ts",
      }),
    ).toEqual(["app/use.ts", "core/a.ts"]);
  });

  it("links an absolute specifier without a baseUrl", () => {
    expect(
      reachingFiles({
        sources: {
          "core/a.ts": "export const a = 1;\n",
          "app/use.ts": `import { a } from "${ROOT}/core/a";\n`,
        },
        target: "core/a.ts",
      }),
    ).toEqual(["app/use.ts", "core/a.ts"]);
  });

  it("links a non-relative specifier through the scope's baseUrl", () => {
    const sources: Readonly<Record<string, string>> = {
      "core/a.ts": "export const a = 1;\n",
      "app/use.ts": 'import { a } from "core/a";\n',
    };

    expect(reachingFiles({ sources, target: "core/a.ts" })).toEqual(["core/a.ts"]);
    expect(
      reachingFiles({ sources, target: "core/a.ts", scope: { baseUrl: ROOT, paths: {} } }),
    ).toEqual(["app/use.ts", "core/a.ts"]);
  });

  it("links exact and wildcard paths mappings of the scope", () => {
    expect(
      reachingFiles({
        sources: {
          "core/a.ts": "export const a = 1;\n",
          "app/exact.ts": 'import { a } from "@core";\n',
          "app/wildcard.ts": 'import { a } from "@core/a";\n',
        },
        target: "core/a.ts",
        scope: {
          baseUrl: undefined,
          paths: { "@core": [`${ROOT}/core/a.ts`], "@core/*": [`${ROOT}/core/*`] },
        },
      }),
    ).toEqual(["app/exact.ts", "app/wildcard.ts", "core/a.ts"]);
  });

  it("links a paths specifier ending in a separator to the directory's index file", () => {
    expect(
      reachingFiles({
        sources: {
          "core/index.ts": "export const a = 1;\n",
          "app/use.ts": 'import { a } from "@core/";\n',
        },
        target: "core/index.ts",
        scope: { baseUrl: undefined, paths: { "@core/*": [`${ROOT}/core/*`] } },
      }),
    ).toEqual(["app/use.ts", "core/index.ts"]);
  });

  it("links an arbitrary extension import to its declaration file", () => {
    expect(
      reachingFiles({
        sources: {
          "core/styles.d.css.ts": "export declare const button: string;\n",
          "app/use.ts": 'import { button } from "../core/styles.css";\n',
        },
        target: "core/styles.d.css.ts",
      }),
    ).toEqual(["app/use.ts", "core/styles.d.css.ts"]);
  });

  it("links a directory import to the directory's index file", () => {
    expect(
      reachingFiles({
        sources: {
          "shapes/index.ts": "export const circle = 1;\n",
          "app/use.ts": 'import { circle } from "../shapes";\n',
        },
        target: "shapes/index.ts",
      }),
    ).toEqual(["app/use.ts", "shapes/index.ts"]);
  });

  it("links a directory import to any file below a package directory", () => {
    const sources: Readonly<Record<string, string>> = {
      "core/src/a.ts": "export const a = 1;\n",
      "app/use.ts": 'import { a } from "../core";\n',
    };

    expect(reachingFiles({ sources, target: "core/src/a.ts" })).toEqual(["core/src/a.ts"]);
    expect(
      reachingFiles({ sources, target: "core/src/a.ts", packageDirectories: ["core"] }),
    ).toEqual(["app/use.ts", "core/src/a.ts"]);
  });
});
