import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import {
  InMemoryFileSystem,
  NodeFileSystem,
  type ResolvedPath,
  type SymbolIdentity,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";
import { TypeScriptProjectGraph } from "./typescript-project-graph.js";
import { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

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
  it("resolves configured and inferred workspace package exports from a drive root", async () => {
    const fileSystem = driveRootFileSystem();
    const files = driveRootWorkspaceFiles(fileSystem);
    const backend = new TypeScriptBackend(fileSystem);
    await backend.refresh({ snapshot: { root: "C:/repo", files }, coverage: "workspace" });

    await expect(
      calleeNames(
        backend,
        files,
        symbolIdentity("packages/app/src/index.ts", "useConfiguredPackages"),
      ),
    ).resolves.toEqual(["featureTarget", "rootTarget", "patternTarget"]);
    await expect(
      calleeNames(backend, files, symbolIdentity("scratch/outside.ts", "useInferredPackages")),
    ).resolves.toEqual(["featureTarget", "rootTarget", "patternTarget"]);

    const graph = new TypeScriptProjectGraph(fileSystem);
    const refresh = await graph.refresh({ root: "C:/repo", files });
    const configuredPaths = graph
      .programFor("packages/app/src/index.ts")
      ?.getCompilerOptions().paths;
    const inferredPaths = graph.programFor("scratch/outside.ts")?.getCompilerOptions().paths;

    expect(refresh.configuredProjectCount).toBe(3);
    expect(configuredPaths).toMatchObject(driveRootPackagePaths());
    expect(inferredPaths).toEqual(driveRootPackagePaths());
    expect(inferredPaths?.["@configured-only/*"]).toBeUndefined();
  });

  it("loads only the owning semantic project for a targeted source lookup", async () => {
    const projectFixture = fixture();
    const loadedFileCounts: number[] = [];
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem, {
      semanticProjectLoaded: (fileCount) => loadedFileCounts.push(fileCount),
    });
    await graph.refresh(await projectFixture.snapshot());

    expect(graph.sourceFileFor("packages/domain/src/index.ts")).toBeDefined();
    expect(loadedFileCounts).toEqual([5]);
  });

  it("locates a declaration without materializing unrelated semantic projects", async () => {
    const projectFixture = fixture();
    const loadedFileCounts: number[] = [];
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem, {
      semanticProjectLoaded: (fileCount) => loadedFileCounts.push(fileCount),
    });
    const snapshot = await projectFixture.snapshot();
    await graph.refresh(snapshot);
    const state = new TypeScriptWorkspaceState(projectFixture.fileSystem, undefined, graph);
    await state.refresh(snapshot.files);

    expect(
      state.locate(symbolIdentity("packages/domain/src/index.ts", "workspaceTarget")),
    ).toHaveLength(1);
    expect(loadedFileCounts).toEqual([5]);
  });
  it("loads recursive project references and reuses services across no-change refreshes", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();

    const first = await graph.refresh(snapshot);
    const languageService = graph.languageServiceFor("packages/app/src/index.ts");
    let absoluteReads = 0;
    const unchangedSnapshot: WorkspaceSnapshot = {
      root: snapshot.root,
      files: snapshot.files.map((file) => ({
        relative: file.relative,
        get absolute() {
          absoluteReads += 1;
          return file.absolute;
        },
        metadata: file.metadata,
      })),
    };
    const second = await graph.refresh(unchangedSnapshot);

    expect(first).toEqual({
      root: snapshot.root,
      configuredProjectCount: 3,
      inferredFileCount: 1,
      changedConfigurationCount: 6,
    });
    expect(second.changedConfigurationCount).toBe(0);
    expect(absoluteReads).toBe(0);
    expect(graph.languageServiceFor("packages/app/src/index.ts")).toBe(languageService);
    expect(graph.programFor("scratch/outside.ts")).toBeDefined();
  });

  it("keeps full project ownership across a selection refresh", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const backend = new TypeScriptBackend(projectFixture.fileSystem, undefined, graph);
    const snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });
    const languageService = graph.languageServiceFor("packages/app/src/index.ts");

    await backend.refresh({
      snapshot: { root: snapshot.root, files: [snapshot.files[0]!] },
      coverage: "selection",
    });
    await backend.refresh({ snapshot, coverage: "workspace" });

    expect(graph.languageServiceFor("packages/app/src/index.ts")).toBe(languageService);
    expect(graph.programFor("packages/domain/src/index.ts")).toBeDefined();
  });

  it("discovers a previously missing referenced configuration without source changes", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({
        files: [],
        references: [
          { path: "packages/app" },
          { path: "packages/domain" },
          { path: "packages/pending" },
        ],
      }),
    );
    projectFixture.write("packages/pending/src/index.ts", "export const pendingTarget = true;\n");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    const before = await graph.refresh(snapshot);

    projectFixture.write(
      "packages/pending/tsconfig.json",
      JSON.stringify({ include: ["src/**/*.ts"] }),
    );
    const after = await graph.refresh(snapshot);

    expect(before.configuredProjectCount).toBe(3);
    expect(after.configuredProjectCount).toBe(4);
    expect(after.changedConfigurationCount).toBe(1);
  });

  it("invalidates equal-size configuration content after modification time is restored", async () => {
    const projectFixture = fixture();
    const configurationPath = join(projectFixture.root, "packages/app/tsconfig.base.json");
    const originalContent = readFileSync(configurationPath, "utf8");
    const originalTimes = statSync(configurationPath);
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    await graph.refresh(snapshot);

    const changedContent = originalContent.replace("@domain/*", "@demand/*");
    expect(changedContent).toHaveLength(originalContent.length);
    projectFixture.write("packages/app/tsconfig.base.json", changedContent);
    utimesSync(configurationPath, originalTimes.atime, originalTimes.mtime);
    const changed = await graph.refresh(snapshot);
    const paths = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().paths;

    expect(changed.changedConfigurationCount).toBe(1);
    expect(paths?.["@demand/*"]).toBeDefined();
    expect(paths?.["@domain/*"]).toBeUndefined();
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

  it("keeps implicit outDir contents outside configured membership", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write(
      "packages/app/tsconfig.json",
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { composite: true, outDir: "dist" },
        references: [{ path: "../domain" }],
        include: ["**/*.ts"],
      }),
    );
    projectFixture.write(
      "packages/app/dist/generated.ts",
      [
        'import { appLocalTarget } from "@local/local";',
        "export function generatedCaller(): string { return appLocalTarget(); }",
        "",
      ].join("\n"),
    );

    await graph.refresh(await projectFixture.snapshot());
    const options = graph.programFor("packages/app/dist/generated.ts")?.getCompilerOptions();

    expect(options?.paths?.["@local/*"]).toBeUndefined();
    expect(options?.paths?.["@configured/domain"]).toBeDefined();
  });

  it("keeps drive-root outDir contents outside case-insensitive configured membership", async () => {
    const fileSystem = driveRootFileSystem({
      appConfiguration: {
        compilerOptions: {
          baseUrl: ".",
          outDir: "Dist",
          paths: { "@configured-only/*": ["src/*"] },
        },
        include: ["**/*.ts"],
      },
      generatedSource: "export const generated = true;\n",
    });
    const files = driveRootWorkspaceFiles(fileSystem, "packages/app/dist/generated.ts");
    const graph = new TypeScriptProjectGraph(fileSystem);

    await graph.refresh({ root: "C:/repo", files });
    const generatedOptions = graph
      .programFor("packages/app/dist/generated.ts")
      ?.getCompilerOptions();

    expect(generatedOptions?.paths).toEqual(driveRootPackagePaths());
    expect(generatedOptions?.paths?.["@configured-only/*"]).toBeUndefined();
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

function driveRootFileSystem(
  options: {
    readonly appConfiguration?: Record<string, unknown>;
    readonly generatedSource?: string;
  } = {},
): InMemoryFileSystem {
  return new InMemoryFileSystem({
    "C:/repo/tsconfig.json": JSON.stringify({
      files: [],
      references: [{ path: "packages/app" }, { path: "packages/domain" }],
    }),
    "C:/repo/packages/app/tsconfig.json": JSON.stringify(
      options.appConfiguration ?? {
        compilerOptions: {
          baseUrl: ".",
          paths: { "@configured-only/*": ["src/*"] },
        },
        references: [{ path: "../domain" }],
        include: ["src/**/*.ts"],
      },
    ),
    "C:/repo/packages/domain/tsconfig.json": JSON.stringify({
      compilerOptions: { composite: true },
      include: ["src/**/*.ts"],
    }),
    "C:/repo/packages/domain/package.json": JSON.stringify({
      name: "@workspace/domain",
      exports: {
        ".": "./src/index.ts",
        "./feature": "./src/feature.ts",
        "./patterns/*": "./src/patterns/*.ts",
      },
    }),
    "C:/repo/packages/domain/src/index.ts":
      'export function rootTarget(): string { return "root"; }\n',
    "C:/repo/packages/domain/src/feature.ts":
      'export function featureTarget(): string { return "feature"; }\n',
    "C:/repo/packages/domain/src/patterns/one.ts":
      'export function patternTarget(): string { return "pattern"; }\n',
    "C:/repo/packages/app/src/index.ts": driveRootPackageConsumer("useConfiguredPackages"),
    "C:/repo/scratch/outside.ts": driveRootPackageConsumer("useInferredPackages"),
    ...(options.generatedSource
      ? { "C:/repo/packages/app/dist/generated.ts": options.generatedSource }
      : {}),
  });
}

function driveRootPackageConsumer(name: string): string {
  return [
    'import { rootTarget } from "@workspace/domain";',
    'import { featureTarget } from "@workspace/domain/feature";',
    'import { patternTarget } from "@workspace/domain/patterns/one";',
    `export function ${name}(): string {`,
    "  return rootTarget() + featureTarget() + patternTarget();",
    "}",
    "",
  ].join("\n");
}

function driveRootWorkspaceFiles(
  fileSystem: InMemoryFileSystem,
  ...additionalRelativePaths: readonly string[]
): WorkspaceSnapshot["files"] {
  const relativePaths = [
    "packages/app/src/index.ts",
    "packages/domain/src/feature.ts",
    "packages/domain/src/index.ts",
    "packages/domain/src/patterns/one.ts",
    "scratch/outside.ts",
    ...additionalRelativePaths,
  ];
  return relativePaths.map((relativePath) => ({
    relative: relativePath,
    absolute: `C:/repo/${relativePath}`,
    metadata: fileSystem.metadataSync(`C:/repo/${relativePath}`),
  }));
}

function driveRootPackagePaths(): Record<string, string[]> {
  return {
    "@workspace/domain": ["C:/repo/packages/domain/src/index.ts"],
    "@workspace/domain/feature": ["C:/repo/packages/domain/src/feature.ts"],
    "@workspace/domain/patterns/*": ["C:/repo/packages/domain/src/patterns/*.ts"],
  };
}
