import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import {
  NodeFileSystem,
  type ResolvedPath,
  type SymbolIdentity,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";
import { TypeScriptProjectGraph } from "./typescript-project-graph.js";

class ConfiguredProjectFixture {
  readonly root: string;
  readonly fileSystem = new NodeFileSystem();

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "symnav-configured-projects-"));
    cpSync(fixturePath("configured-project-cases"), this.root, { recursive: true });
    mkdirSync(join(this.root, ".git"));
    writeFileSync(join(this.root, ".git", "HEAD"), "ref: refs/heads/main\n");
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  write(relativePath: string, content: string): void {
    const absolute = join(this.root, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }

  remove(relativePath: string): void {
    unlinkSync(join(this.root, relativePath));
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const relativePaths = this.sourceFiles(this.root)
      .map((absolute) => relative(this.root, absolute).replaceAll("\\", "/"))
      .sort();
    return {
      root: this.root.replaceAll("\\", "/"),
      files: await Promise.all(
        relativePaths.map(async (relativePath) => {
          const absolute = join(this.root, relativePath).replaceAll("\\", "/");
          return {
            relative: relativePath,
            absolute,
            metadata: await this.fileSystem.metadata(absolute),
          };
        }),
      ),
    };
  }

  private sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === ".git" ? [] : this.sourceFiles(absolute);
      return TypeScriptBackend.accepts(entry.name) ? [absolute] : [];
    });
  }
}

const fixtures: ConfiguredProjectFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function fixture(): ConfiguredProjectFixture {
  const created = new ConfiguredProjectFixture();
  fixtures.push(created);
  return created;
}

describe("TypeScriptProjectGraph", () => {
  it("loads recursive project references and reuses services across no-change refreshes", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();

    const first = await graph.refresh(snapshot);
    const languageService = graph.languageServiceFor("packages/app/src/index.ts");
    const second = await graph.refresh(await projectFixture.snapshot());

    expect(first).toEqual({
      root: snapshot.root,
      configuredProjectCount: 3,
      inferredFileCount: 1,
      changedConfigurationCount: 6,
    });
    expect(second.changedConfigurationCount).toBe(0);
    expect(graph.languageServiceFor("packages/app/src/index.ts")).toBe(languageService);
    expect(graph.programFor("scratch/outside.ts")).toBeDefined();
  });

  it("invalidates compiler options and project references on the next refresh", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot());

    projectFixture.write(
      "packages/app/tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@changed/*": ["../domain/src/*"] } },
        references: [{ path: "../domain" }],
        include: ["src/**/*.ts"],
      }),
    );
    const compilerOptionsChanged = await graph.refresh(await projectFixture.snapshot());
    const changedOptions = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions();

    expect(compilerOptionsChanged.configuredProjectCount).toBe(3);
    expect(compilerOptionsChanged.changedConfigurationCount).toBe(2);
    expect(changedOptions?.paths).toEqual({
      "@changed/*": [`${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/*`],
      "@configured/app": [`${projectFixture.root.replaceAll("\\", "/")}/packages/app/src/index.ts`],
      "@configured/domain": [
        `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/index.ts`,
      ],
      "@configured/domain/feature": [
        `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/feature.ts`,
      ],
      "@configured/domain/features/*": [
        `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/features/*.ts`,
      ],
    });

    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({ files: [], references: [{ path: "packages/domain" }] }),
    );
    const referencesChanged = await graph.refresh(await projectFixture.snapshot());
    const referencedOptions = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions();

    expect(referencesChanged.configuredProjectCount).toBe(2);
    expect(referencesChanged.inferredFileCount).toBe(3);
    expect(referencesChanged.changedConfigurationCount).toBe(2);
    expect(referencedOptions?.paths?.["@changed/*"]).toBeUndefined();
  });

  it("invalidates workspace package exports and source membership", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot());

    projectFixture.write(
      "packages/domain/package.json",
      JSON.stringify({ name: "@configured/domain", exports: { ".": "./src/next.ts" } }),
    );
    projectFixture.write(
      "packages/domain/src/next.ts",
      "export function nextTarget(): string { return 'next'; }\n",
    );
    projectFixture.remove("scratch/outside.ts");

    const changed = await graph.refresh(await projectFixture.snapshot());
    const options = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions();

    expect(changed.changedConfigurationCount).toBe(1);
    expect(changed.inferredFileCount).toBe(0);
    expect(options?.paths?.["@configured/domain"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/next.ts`,
    ]);
  });

  it("applies and invalidates extended compiler options", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    const first = await graph.refresh(await projectFixture.snapshot());
    const inheritedOptions = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions();
    projectFixture.write(
      "packages/app/tsconfig.base.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@domain/*": ["../domain/src/*"],
            "@inherited/*": ["./missing/*"],
            "@local/*": ["src/*"],
          },
        },
      }),
    );
    const changed = await graph.refresh(await projectFixture.snapshot());
    const changedOptions = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions();

    expect(first.changedConfigurationCount).toBe(6);
    expect(inheritedOptions?.paths?.["@inherited/*"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/*`,
    ]);
    expect(changed.changedConfigurationCount).toBe(1);
    expect(changedOptions?.paths?.["@inherited/*"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/app/missing/*`,
    ]);
  });

  it("falls back to one inferred project for malformed or missing root configuration", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write("tsconfig.json", "{ malformed");

    const malformed = await graph.refresh(await projectFixture.snapshot());
    projectFixture.remove("tsconfig.json");
    const missing = await graph.refresh(await projectFixture.snapshot());

    expect(malformed.configuredProjectCount).toBe(0);
    expect(malformed.inferredFileCount).toBe(8);
    expect(missing.configuredProjectCount).toBe(0);
    expect(missing.inferredFileCount).toBe(8);
    expect(graph.languageServiceFor("scratch/outside.ts")).toBeDefined();
  });

  it("gives uncovered files workspace mappings without configured compiler options", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    await graph.refresh(await projectFixture.snapshot());

    const options = graph.programFor("scratch/outside.ts")?.getCompilerOptions();

    expect(options?.paths?.["@configured/domain"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/index.ts`,
    ]);
    expect(options?.paths?.["@configured/domain/feature"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/feature.ts`,
    ]);
    expect(options?.paths?.["@configured/domain/features/*"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/features/*.ts`,
    ]);
    expect(options?.paths?.["@local/*"]).toBeUndefined();
  });

  it("maps exact and patterned workspace package subpath exports", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write(
      "packages/domain/package.json",
      JSON.stringify({
        name: "@configured/domain",
        exports: {
          "./feature": "./src/feature.ts",
          "./features/*": "./src/features/*.ts",
        },
      }),
    );

    await graph.refresh(await projectFixture.snapshot());
    const paths = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().paths;

    expect(paths?.["@configured/domain/feature"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/feature.ts`,
    ]);
    expect(paths?.["@configured/domain/features/*"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/features/*.ts`,
    ]);
  });

  it("changes semantic answers after path alias configuration edits", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    let snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });
    const app = symbolIdentity("packages/app/src/index.ts", "useConfiguredImports");
    expect(await calleeNames(backend, snapshot.files, app)).toEqual([
      "workspaceTarget",
      "pathTarget",
    ]);

    projectFixture.write(
      "packages/app/tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@domain/*": ["./missing/*"] } },
        references: [{ path: "../domain" }],
        include: ["src/**/*.ts"],
      }),
    );
    snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });

    expect(await calleeNames(backend, snapshot.files, app)).toEqual(["workspaceTarget"]);
  });

  it("changes semantic answers after workspace package export edits", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    let snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });
    const app = symbolIdentity("packages/app/src/index.ts", "useConfiguredImports");

    projectFixture.write(
      "packages/domain/package.json",
      JSON.stringify({ name: "@configured/domain", exports: { ".": "./src/missing.ts" } }),
    );
    snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });

    expect(await calleeNames(backend, snapshot.files, app)).toEqual(["pathTarget"]);
  });

  it("updates inferred semantic membership after accepted source changes", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    let snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });
    projectFixture.write(
      "scratch/added.ts",
      "export function addedInferredTarget(): string { return 'added'; }\n",
    );
    snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });

    await expect(
      backend.resolveSymbols(snapshot.files, "addedInferredTarget", { mode: "exact" }),
    ).resolves.toHaveLength(1);

    projectFixture.remove("scratch/added.ts");
    snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });
    await expect(
      backend.resolveSymbols(snapshot.files, "addedInferredTarget", { mode: "exact" }),
    ).resolves.toEqual([]);
  });
});

async function calleeNames(
  backend: TypeScriptBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly string[]> {
  const callees = await backend.findCallees(files, identity);
  return callees.map((callee) => callee.symbol.identity.segments.at(-1)?.name ?? "");
}

function symbolIdentity(file: string, name: string): SymbolIdentity {
  return { file, segments: [{ name }] };
}
