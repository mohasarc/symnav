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

import { afterEach, describe, expect, it, vi } from "vitest";
import { fixturePath } from "@symnav/testing";
import {
  InMemoryFileSystem,
  NodeFileSystem,
  type ResolvedPath,
  type SymbolIdentity,
  type WorkspaceSnapshot,
} from "@symnav/core";
import type { ts } from "ts-morph";

import { TypeScriptBackend } from "./typescript-backend.js";
import { TypeScriptProjectGraph } from "./typescript-project-graph.js";
import { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

class ConfiguredProjectFixture {
  readonly root: string;
  readonly fileSystem = new NodeFileSystem();
  private readonly ignoredDirectories = new Set<string>();

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

  ignore(relativeDirectory: string): void {
    this.ignoredDirectories.add(join(this.root, relativeDirectory));
  }

  remove(relativePath: string): void {
    unlinkSync(join(this.root, relativePath));
  }

  snapshot(): Promise<WorkspaceSnapshot> {
    return this.snapshotOf(this.workspaceFiles(this.root).filter(TypeScriptBackend.accepts));
  }

  workspaceSnapshot(): Promise<WorkspaceSnapshot> {
    return this.snapshotOf(this.workspaceFiles(this.root));
  }

  private async snapshotOf(absolutePaths: readonly string[]): Promise<WorkspaceSnapshot> {
    const relativePaths = absolutePaths
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

  private workspaceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = join(directory, entry.name);
      const skipped = entry.name === ".git" || this.ignoredDirectories.has(absolute);
      if (entry.isDirectory()) return skipped ? [] : this.workspaceFiles(absolute);
      return [absolute];
    });
  }
}

const SHARED_IMPORT_PROJECT_COUNT = 60;

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
    await backend.refresh({
      snapshot: { root: "C:/repo", files },
      workspaceSnapshot: { root: "C:/repo", files },
      coverage: "workspace",
    });

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
    const refresh = await graph.refresh({ root: "C:/repo", files }, { root: "C:/repo", files });
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
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

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
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
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

    const first = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
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
    const second = await graph.refresh(unchangedSnapshot, await projectFixture.workspaceSnapshot());

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
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });
    const languageService = graph.languageServiceFor("packages/app/src/index.ts");

    await backend.refresh({
      snapshot: { root: snapshot.root, files: [snapshot.files[0]!] },
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "selection",
    });
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

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
    const before = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    projectFixture.write(
      "packages/pending/tsconfig.json",
      JSON.stringify({ include: ["src/**/*.ts"] }),
    );
    const after = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    expect(before.configuredProjectCount).toBe(3);
    expect(after.configuredProjectCount).toBe(4);
    expect(after.changedConfigurationCount).toBe(1);
  });

  it("discovers a previously missing workspace package without source changes", async () => {
    const projectFixture = fixture();
    const packagePath = join(projectFixture.root, "packages/domain/package.json");
    const packageContent = readFileSync(packagePath, "utf8");
    projectFixture.remove("packages/domain/package.json");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    const before = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    projectFixture.write("packages/domain/package.json", packageContent);
    const after = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
    const paths = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().paths;

    expect(before.changedConfigurationCount).toBe(5);
    expect(after.changedConfigurationCount).toBe(1);
    expect(paths?.["@configured/domain"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/index.ts`,
    ]);
  });

  it("stops observing configuration inputs after they become unreachable", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({ files: [], references: [{ path: "packages/domain" }] }),
    );
    projectFixture.write(
      "packages/app/tsconfig.json",
      JSON.stringify({ include: ["src/**/*.ts"] }),
    );
    const narrowedSnapshot = await projectFixture.snapshot();
    const narrowed = await graph.refresh(
      narrowedSnapshot,
      await projectFixture.workspaceSnapshot(),
    );
    const appService = graph.languageServiceFor("packages/app/src/index.ts");

    projectFixture.write(
      "packages/app/tsconfig.base.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const unchanged = await graph.refresh(
      narrowedSnapshot,
      await projectFixture.workspaceSnapshot(),
    );

    expect(narrowed.changedConfigurationCount).toBe(3);
    expect(unchanged.changedConfigurationCount).toBe(0);
    expect(graph.languageServiceFor("packages/app/src/index.ts")).toBe(appService);
  });

  it("orders every owning project and uses the nearest owner as primary", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "packages/app/tsconfig.json",
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { composite: true },
        references: [{ path: "../domain" }],
        files: ["src/index.ts", "../domain/src/index.ts"],
      }),
    );
    projectFixture.write("scratch/outside.ts", "export const outside = true;\n");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    const sourceFiles = graph.sourceFilesFor("packages/domain/src/index.ts");
    const primary = graph.sourceFileFor("packages/domain/src/index.ts");

    expect(
      sourceFiles.map((sourceFile) => sourceFile.getProject().getCompilerOptions().baseUrl),
    ).toEqual([
      projectFixture.root.replaceAll("\\", "/") + "/packages/domain",
      projectFixture.root.replaceAll("\\", "/") + "/packages/app",
    ]);
    expect(primary).toBe(sourceFiles[0]);
  });

  it("invalidates equal-size configuration content after modification time is restored", async () => {
    const projectFixture = fixture();
    const configurationPath = join(projectFixture.root, "packages/app/tsconfig.base.json");
    const originalContent = readFileSync(configurationPath, "utf8");
    const originalTimes = statSync(configurationPath);
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    const changedContent = originalContent.replace("@domain/*", "@demand/*");
    expect(changedContent).toHaveLength(originalContent.length);
    projectFixture.write("packages/app/tsconfig.base.json", changedContent);
    utimesSync(configurationPath, originalTimes.atime, originalTimes.mtime);
    const changed = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
    const paths = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().paths;

    expect(changed.changedConfigurationCount).toBe(1);
    expect(paths?.["@demand/*"]).toBeDefined();
    expect(paths?.["@domain/*"]).toBeUndefined();
  });

  it("invalidates compiler options and project references on the next refresh", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    projectFixture.write(
      "packages/app/tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@changed/*": ["../domain/src/*"] } },
        references: [{ path: "../domain" }],
        include: ["src/**/*.ts"],
      }),
    );
    const compilerOptionsChanged = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
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
    const referencesChanged = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
    const referencedOptions = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions();

    expect(referencesChanged.configuredProjectCount).toBe(3);
    expect(referencesChanged.inferredFileCount).toBe(1);
    expect(referencesChanged.changedConfigurationCount).toBe(1);
    expect(referencedOptions?.paths?.["@changed/*"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/*`,
    ]);
  });

  it("invalidates workspace package exports and source membership", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    projectFixture.write(
      "packages/domain/package.json",
      JSON.stringify({ name: "@configured/domain", exports: { ".": "./src/next.ts" } }),
    );
    projectFixture.write(
      "packages/domain/src/next.ts",
      "export function nextTarget(): string { return 'next'; }\n",
    );
    projectFixture.remove("scratch/outside.ts");

    const changed = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
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

    const first = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
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
    const changed = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
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

  it("builds one semantic project for a root configuration and the nested configuration it extends", async () => {
    const projectFixture = fixture();
    const loadedFileCounts: number[] = [];
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem, {
      semanticProjectLoaded: (fileCount) => loadedFileCounts.push(fileCount),
    });
    projectFixture.write("tsconfig.json", JSON.stringify({ extends: "./src/tsconfig.json" }));
    projectFixture.write(
      "src/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true }, include: ["./vs/**/*.ts"] }),
    );
    for (const name of ["a", "b", "c"]) {
      projectFixture.write(`src/vs/${name}.ts`, `export const ${name} = 1;\n`);
    }

    const refresh = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
    const sourceFiles = graph.sourceFilesFor("src/vs/a.ts");

    expect(refresh.configuredProjectCount).toBe(4);
    expect(sourceFiles).toHaveLength(1);
    expect(sourceFiles[0]?.getProject().getCompilerOptions().strict).toBe(true);
    expect(loadedFileCounts.filter((fileCount) => fileCount === 3)).toHaveLength(1);
  });

  it("keeps separate semantic projects for equal files with different compiler options", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({ extends: "./src/tsconfig.json", compilerOptions: { strict: false } }),
    );
    projectFixture.write(
      "src/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true }, include: ["./vs/**/*.ts"] }),
    );
    projectFixture.write("src/vs/a.ts", "export const a = 1;\n");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    const strictness = graph
      .sourceFilesFor("src/vs/a.ts")
      .map((sourceFile) => sourceFile.getProject().getCompilerOptions().strict);

    expect(strictness).toEqual([false, true]);
  });

  it.each([".", "./"])(
    "owns every file below a root configuration that includes %j",
    async (include) => {
      const projectFixture = fixture();
      const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
      projectFixture.write(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { strict: true }, include: [include] }),
      );

      await graph.refresh(
        await projectFixture.snapshot(),
        await projectFixture.workspaceSnapshot(),
      );
      const program = graph.programFor("scratch/outside.ts");

      expect(program?.getCompilerOptions().strict).toBe(true);
      expect(program?.getRootFileNames()).toContain(
        `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/index.ts`,
      );
    },
  );

  it("owns the files a root configuration includes through extends", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write("tsconfig.json", JSON.stringify({ extends: "./src/tsconfig.json" }));
    projectFixture.write(
      "src/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true }, include: ["./vs/**/*.ts"] }),
    );
    projectFixture.write("src/vs/a.ts", "export const a = 1;\n");
    projectFixture.write("src/vs/b.ts", "export const b = 2;\n");

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    const program = graph.programFor("src/vs/a.ts");

    expect(program?.getCompilerOptions().strict).toBe(true);
    expect(program?.getRootFileNames()).toContain(
      `${projectFixture.root.replaceAll("\\", "/")}/src/vs/b.ts`,
    );
  });

  it("leaves files a root configuration excludes through extends inferred", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write("tsconfig.json", JSON.stringify({ extends: "./src/tsconfig.json" }));
    projectFixture.write(
      "src/tsconfig.json",
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["./vs/**/*.ts"],
        exclude: ["./vs/skip/**"],
      }),
    );
    projectFixture.write("src/vs/a.ts", "export const a = 1;\n");
    projectFixture.write("src/vs/skip/c.ts", "export const c = 3;\n");

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    expect(graph.programFor("src/vs/a.ts")?.getCompilerOptions().strict).toBe(true);
    expect(graph.programFor("src/vs/skip/c.ts")?.getCompilerOptions().strict).toBeUndefined();
  });

  it("resolves extended paths without baseUrl against the configuration that declares them", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    projectFixture.write("tsconfig.json", JSON.stringify({ extends: "./src/tsconfig.json" }));
    projectFixture.write(
      "src/tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "vs/*": ["./vs/*"] } },
        include: ["./vs/**/*.ts"],
      }),
    );
    projectFixture.write(
      "src/vs/a.ts",
      'import { aliasTarget } from "vs/b";\nexport function useAlias(): number { return aliasTarget(); }\n',
    );
    projectFixture.write("src/vs/b.ts", "export function aliasTarget(): number { return 1; }\n");
    const snapshot = await projectFixture.snapshot();

    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

    await expect(
      calleeNames(backend, snapshot.files, symbolIdentity("src/vs/a.ts", "useAlias")),
    ).resolves.toEqual(["aliasTarget"]);
  });

  it("discovers nested configurations behind a malformed or missing root configuration", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write("tsconfig.json", "{ malformed");

    const malformed = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );
    projectFixture.remove("tsconfig.json");
    const missing = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );

    expect(malformed.configuredProjectCount).toBe(2);
    expect(missing.configuredProjectCount).toBe(2);
    expect(graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().baseUrl).toBe(
      `${projectFixture.root.replaceAll("\\", "/")}/packages/app`,
    );
    expect(graph.programFor("scratch/outside.ts")?.getCompilerOptions().composite).toBeUndefined();
  });

  it("keeps an outside ambient declaration in a nested configuration's program", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    projectFixture.write(
      "types/api.d.ts",
      'declare module "api" {\n  export function call(): number;\n}\n',
    );
    projectFixture.write(
      "ext/tsconfig.json",
      JSON.stringify({ files: ["../types/api.d.ts"], include: ["src/**/*"] }),
    );
    projectFixture.write(
      "ext/src/main.ts",
      'import { call } from "api";\nexport function useApi(): number {\n  return call();\n}\n',
    );
    const snapshot = await projectFixture.snapshot();

    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

    await expect(
      calleeNames(backend, snapshot.files, symbolIdentity("ext/src/main.ts", "useApi")),
    ).resolves.toEqual(["call"]);
  });

  it.each(["../../api/vscode.d.ts", "../../api/**/*"])(
    "includes %j from outside a nested configuration without owning it",
    async (outsideInclude) => {
      const projectFixture = fixture();
      const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
      const backend = new TypeScriptBackend(projectFixture.fileSystem, undefined, graph);
      projectFixture.write(
        "api/vscode.d.ts",
        'declare module "vscode" {\n  export function show(): number;\n}\n',
      );
      projectFixture.write(
        "extensions/git/tsconfig.json",
        JSON.stringify({
          compilerOptions: { strict: true },
          include: ["src/**/*", outsideInclude],
        }),
      );
      projectFixture.write(
        "extensions/git/src/main.ts",
        'import { show } from "vscode";\nexport function useShow(): number {\n  return show();\n}\n',
      );
      const snapshot = await projectFixture.snapshot();

      await backend.refresh({
        snapshot,
        workspaceSnapshot: await projectFixture.workspaceSnapshot(),
        coverage: "workspace",
      });

      await expect(
        calleeNames(
          backend,
          snapshot.files,
          symbolIdentity("extensions/git/src/main.ts", "useShow"),
        ),
      ).resolves.toEqual(["show"]);
      expect(graph.programFor("api/vscode.d.ts")?.getCompilerOptions().strict).toBeUndefined();
    },
  );

  it("ignores configurations below node_modules", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.remove("tsconfig.json");
    projectFixture.write(
      "node_modules/vendored/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    projectFixture.write("node_modules/vendored/index.ts", "export const vendored = 1;\n");

    const refresh = await graph.refresh(
      await projectFixture.snapshot(),
      await projectFixture.workspaceSnapshot(),
    );

    expect(refresh.configuredProjectCount).toBe(2);
    expect(
      graph.programFor("node_modules/vendored/index.ts")?.getCompilerOptions().strict,
    ).toBeUndefined();
  });

  it("ignores nested configurations missing from the workspace snapshot", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.remove("tsconfig.json");
    projectFixture.write(
      "scratch/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const workspaceSnapshot = await projectFixture.workspaceSnapshot();
    const ignoredSnapshot: WorkspaceSnapshot = {
      root: workspaceSnapshot.root,
      files: workspaceSnapshot.files.filter((file) => file.relative !== "scratch/tsconfig.json"),
    };

    const refresh = await graph.refresh(await projectFixture.snapshot(), ignoredSnapshot);

    expect(refresh.configuredProjectCount).toBe(2);
    expect(graph.programFor("scratch/outside.ts")?.getCompilerOptions().strict).toBeUndefined();
  });

  it("probes no nested configuration path missing from the workspace snapshot", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const exists = vi.spyOn(projectFixture.fileSystem, "existsSync");

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    const probedPaths = exists.mock.calls.map(([path]) => path.replaceAll("\\", "/"));
    expect(probedPaths).not.toContain(
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/tsconfig.json`,
    );
    expect(probedPaths).not.toContain(
      `${projectFixture.root.replaceAll("\\", "/")}/scratch/tsconfig.json`,
    );
  });

  it("invalidates the graph when a nested configuration appears or disappears", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.remove("tsconfig.json");
    const snapshot = await projectFixture.snapshot();
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    projectFixture.write(
      "scratch/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const appeared = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
    const appearedStrict = graph.programFor("scratch/outside.ts")?.getCompilerOptions().strict;
    projectFixture.remove("scratch/tsconfig.json");
    const disappeared = await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    expect(appeared.configuredProjectCount).toBe(3);
    expect(appearedStrict).toBe(true);
    expect(disappeared.configuredProjectCount).toBe(2);
    expect(graph.programFor("scratch/outside.ts")?.getCompilerOptions().strict).toBeUndefined();
  });

  it("gives uncovered files workspace mappings without configured compiler options", async () => {
    const projectFixture = fixture();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

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

  it("loads JavaScript sources into the inferred project", async () => {
    const projectFixture = fixture();
    projectFixture.write("scratch/lib.mjs", 'export function shout() { return "hey"; }\n');
    projectFixture.write(
      "scratch/use.js",
      'import { shout } from "./lib.mjs";\nexport function useShout() { return shout(); }\n',
    );
    const snapshot = await projectFixture.snapshot();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

    await expect(
      calleeNames(backend, snapshot.files, symbolIdentity("scratch/use.js", "useShout")),
    ).resolves.toEqual(["shout"]);
  });

  it("keeps untracked node_modules JavaScript out of semantic programs", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "node_modules/untyped/package.json",
      JSON.stringify({ name: "untyped", main: "index.js" }),
    );
    projectFixture.write("node_modules/untyped/index.js", "export function untyped() {}\n");
    projectFixture.write(
      "scratch/consumer.ts",
      'import { untyped } from "untyped";\nexport const value = untyped();\n',
    );
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    projectFixture.ignore("node_modules");

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    const loadedFiles = graph
      .programFor("scratch/consumer.ts")
      ?.getSourceFiles()
      .map((sourceFile) => sourceFile.fileName);

    expect(loadedFiles).toContain(
      `${projectFixture.root.replaceAll("\\", "/")}/scratch/consumer.ts`,
    );
    expect(loadedFiles?.filter((fileName) => fileName.includes("/node_modules/untyped/"))).toEqual(
      [],
    );
  });

  it("owns and resolves JavaScript a configuration includes without allowJs", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "legacy/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    projectFixture.write("legacy/src/legacy.js", "export function legacyTarget() {}\n");
    projectFixture.write(
      "legacy/src/use.ts",
      'import { legacyTarget } from "./legacy.js";\nexport function useLegacy(): void { legacyTarget(); }\n',
    );
    const snapshot = await projectFixture.snapshot();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

    await expect(
      calleeNames(backend, snapshot.files, symbolIdentity("legacy/src/use.ts", "useLegacy")),
    ).resolves.toEqual(["legacyTarget"]);
    expect(graph.programFor("legacy/src/legacy.js")?.getCompilerOptions().strict).toBe(true);
  });

  it("owns JavaScript of a configuration that sets allowJs false", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "legacy/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true, allowJs: false }, include: ["src"] }),
    );
    projectFixture.write("legacy/src/legacy.js", "export function legacyTarget() {}\n");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    const options = graph.programFor("legacy/src/legacy.js")?.getCompilerOptions();

    expect(options?.allowJs).toBe(true);
    expect(options?.strict).toBe(true);
  });

  it("finds importers of an inferred .d.ts twin in references to a .js symbol", async () => {
    const projectFixture = fixture();
    writeDeclarationTwinSources(projectFixture, "scratch");

    await expect(
      referencesOf(projectFixture, symbolIdentity("scratch/Tabs.js", "Tabs")),
    ).resolves.toEqual([
      ["scratch/App.ts", 1, "import"],
      ["scratch/App.ts", 3, "usage"],
    ]);
  });

  it("finds importers of a configured .d.ts twin in references to a .js symbol", async () => {
    const projectFixture = fixture();
    projectFixture.write("legacy/tsconfig.json", JSON.stringify({ include: ["src"] }));
    writeDeclarationTwinSources(projectFixture, "legacy/src");

    await expect(
      referencesOf(projectFixture, symbolIdentity("legacy/src/Tabs.js", "Tabs")),
    ).resolves.toEqual([
      ["legacy/src/App.ts", 1, "import"],
      ["legacy/src/App.ts", 3, "usage"],
    ]);
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

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
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

    await graph.refresh({ root: "C:/repo", files }, { root: "C:/repo", files });
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

    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
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
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });
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
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

    expect(await calleeNames(backend, snapshot.files, app)).toEqual(["workspaceTarget"]);
  });

  it("changes semantic answers after workspace package export edits", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    let snapshot = await projectFixture.snapshot();
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });
    const app = symbolIdentity("packages/app/src/index.ts", "useConfiguredImports");

    projectFixture.write(
      "packages/domain/package.json",
      JSON.stringify({ name: "@configured/domain", exports: { ".": "./src/missing.ts" } }),
    );
    snapshot = await projectFixture.snapshot();
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

    expect(await calleeNames(backend, snapshot.files, app)).toEqual(["pathTarget"]);
  });

  it("updates inferred semantic membership after accepted source changes", async () => {
    const projectFixture = fixture();
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    let snapshot = await projectFixture.snapshot();
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });
    projectFixture.write(
      "scratch/added.ts",
      "export function addedInferredTarget(): string { return 'added'; }\n",
    );
    snapshot = await projectFixture.snapshot();
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });

    await expect(
      backend.resolveSymbols(snapshot.files, "addedInferredTarget", { mode: "exact" }),
    ).resolves.toHaveLength(1);

    projectFixture.remove("scratch/added.ts");
    snapshot = await projectFixture.snapshot();
    await backend.refresh({
      snapshot,
      workspaceSnapshot: await projectFixture.workspaceSnapshot(),
      coverage: "workspace",
    });
    await expect(
      backend.resolveSymbols(snapshot.files, "addedInferredTarget", { mode: "exact" }),
    ).resolves.toEqual([]);
  });

  it("parses a shared file separately for configured projects with different targets", async () => {
    const projectFixture = fixture();
    projectFixture.write("core/shared.ts", "export function shared(): number { return 1; }\n");
    for (const target of ["es5", "esnext"]) {
      projectFixture.write(
        `ext/${target}/tsconfig.json`,
        JSON.stringify({ compilerOptions: { target }, include: ["./**/*.ts"] }),
      );
      projectFixture.write(
        `ext/${target}/f.ts`,
        'import { shared } from "../../core/shared";\nexport const value = shared();\n',
      );
    }
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    const sharedPath = `${projectFixture.root.replaceAll("\\", "/")}/core/shared.ts`;
    const es5Shared = graph.programFor("ext/es5/f.ts")?.getSourceFile(sharedPath);
    const esnextShared = graph.programFor("ext/esnext/f.ts")?.getSourceFile(sharedPath);

    expect(es5Shared).toBeDefined();
    expect(esnextShared).toBeDefined();
    expect(es5Shared).not.toBe(esnextShared);
  });

  it("parses shared and default library files once across many configured projects", async () => {
    const projectFixture = fixture();
    writeSharedImportProjects(projectFixture);
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    const programs = sharedImportProjectFiles().map((path) => graph.programFor(path)!);
    const sharedPath = `${projectFixture.root.replaceAll("\\", "/")}/core/shared.ts`;
    const sharedSourceFiles = new Set(programs.map((program) => program.getSourceFile(sharedPath)));
    const libraryFiles = (program: ts.Program) =>
      program.getSourceFiles().filter((file) => program.isSourceFileDefaultLibrary(file));
    const distinctLibraryFiles = new Set(programs.flatMap(libraryFiles));

    expect(new Set(programs).size).toBe(SHARED_IMPORT_PROJECT_COUNT);
    expect(sharedSourceFiles.size).toBe(1);
    expect(libraryFiles(programs[0]!).length).toBeGreaterThan(0);
    expect(distinctLibraryFiles.size).toBe(libraryFiles(programs[0]!).length);
  });

  it("drops shared source files when semantic projects release transient resources", async () => {
    const projectFixture = fixture();
    writeSharedImportProjects(projectFixture);
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    const [path] = sharedImportProjectFiles();
    const sharedPath = `${projectFixture.root.replaceAll("\\", "/")}/core/shared.ts`;
    const beforeRelease = graph.programFor(path!)?.getSourceFile(sharedPath);

    await graph.releaseTransientResources();
    const afterRelease = graph.programFor(path!)?.getSourceFile(sharedPath);

    expect(beforeRelease).toBeDefined();
    expect(afterRelease).toBeDefined();
    expect(afterRelease).not.toBe(beforeRelease);
  });

  it.each([{ mode: "exact" }, { mode: "fuzzy" }, { mode: "regex", regex: /^shared$/ }] as const)(
    "resolves $mode symbol queries without loading a semantic project",
    async (options) => {
      const projectFixture = fixture();
      writeImporterProjects(projectFixture);
      const loadedFileCounts: number[] = [];
      const backend = new TypeScriptBackend(projectFixture.fileSystem, undefined, undefined, {
        semanticProjectLoaded: (fileCount) => loadedFileCounts.push(fileCount),
      });
      const snapshot = await projectFixture.snapshot();
      await backend.refresh({
        snapshot,
        workspaceSnapshot: await projectFixture.workspaceSnapshot(),
        coverage: "workspace",
      });

      const symbols = await backend.resolveSymbols(snapshot.files, "shared", options);

      expect(symbols.length).toBeGreaterThan(0);
      expect(loadedFileCounts).toEqual([]);
    },
  );

  it("loads only semantic projects whose files can import the requested file", async () => {
    const projectFixture = fixture();
    writeImporterProjects(projectFixture);
    const loadedFileCounts: number[] = [];
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem, {
      semanticProjectLoaded: (fileCount) => loadedFileCounts.push(fileCount),
    });
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    const configurations = importerProjectConfigurations(graph, projectFixture);

    expect(configurations).toEqual(
      ["core", "ext/alias", "ext/package", "ext/relative", "ext/transitive"].map(
        (directory) => `${directory}/tsconfig.json`,
      ),
    );
    expect(loadedFileCounts).toHaveLength(configurations.length);
  });

  it.each(["core/src/shared.ts", "shapes/index.ts", "core/src/globals.d.ts"])(
    "returns every project whose program contains %s",
    async (target) => {
      const projectFixture = fixture();
      writeResolutionEdgeProjects(projectFixture);
      const snapshot = await projectFixture.snapshot();
      const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
      await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());

      const returned = projectsReturnedFor(graph, projectFixture, target);

      expect(returned.length).toBeGreaterThan(1);
      expect(returned).toEqual(projectsWhoseProgramContains(graph, snapshot, target));
    },
  );

  it("returns a project that starts importing the target after a refresh", async () => {
    const projectFixture = fixture();
    writeImporterProjects(projectFixture);
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());
    const target = "core/src/shared.ts";
    expect(projectsReturnedFor(graph, projectFixture, target)).not.toContain(
      "ext/other/tsconfig.json",
    );

    projectFixture.write(
      "ext/other/late.ts",
      'import { shared } from "../../core/src/shared";\nexport const late = shared();\n',
    );
    const snapshot = await projectFixture.snapshot();
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
    const returned = projectsReturnedFor(graph, projectFixture, target);

    expect(returned).toContain("ext/other/tsconfig.json");
    expect(returned).toEqual(projectsWhoseProgramContains(graph, snapshot, target));
  });

  it("returns every project whose program contains a tracked node_modules target", async () => {
    const projectFixture = fixture();
    writeImporterProjects(projectFixture);
    projectFixture.write(
      "node_modules/vlib/index.d.ts",
      "export declare function vendored(): number;\n",
    );
    projectFixture.write("ext/vendor/tsconfig.json", JSON.stringify({ include: ["./**/*.ts"] }));
    projectFixture.write(
      "ext/vendor/use.ts",
      'import { vendored } from "vlib";\nexport const value = vendored();\n',
    );
    const snapshot = await projectFixture.snapshot();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
    const target = "node_modules/vlib/index.d.ts";

    const returned = projectsReturnedFor(graph, projectFixture, target);

    expect(returned).toContain("ext/vendor/tsconfig.json");
    expect(returned).toEqual(projectsWhoseProgramContains(graph, snapshot, target));
  });

  it("returns every project whose program contains a target imported through package imports", async () => {
    const projectFixture = fixture();
    writeResolutionEdgeProjects(projectFixture);
    writePackageImportsProject(projectFixture);
    const snapshot = await projectFixture.snapshot();
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(snapshot, await projectFixture.workspaceSnapshot());
    const target = "core/src/shared.ts";

    const returned = projectsReturnedFor(graph, projectFixture, target);

    expect(returned).toContain("ext/package-imports/tsconfig.json");
    expect(returned).toEqual(projectsWhoseProgramContains(graph, snapshot, target));
  });

  it.each([
    { jsx: "react-jsx" },
    { importHelpers: true },
    { rootDirs: [".", "../../core/src"] },
    { typeRoots: ["./types"] },
    { moduleSuffixes: [".native", ""] },
    { types: ["../../core/src/globals"] },
  ])("loads a project whose resolution the importer scan can't bound: %j", async (options) => {
    const projectFixture = fixture();
    writeImporterProjects(projectFixture);
    projectFixture.write(
      "ext/unrelated/tsconfig.json",
      JSON.stringify({ compilerOptions: options, include: ["./**/*.ts"] }),
    );
    const loadedFileCounts: number[] = [];
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem, {
      semanticProjectLoaded: (fileCount) => loadedFileCounts.push(fileCount),
    });
    await graph.refresh(await projectFixture.snapshot(), await projectFixture.workspaceSnapshot());

    const reachingProjectCount = importerProjectConfigurations(graph, projectFixture).length;

    expect(loadedFileCounts).toHaveLength(reachingProjectCount + 1);
  });
});

function configurationName(configFilePath: unknown, root: string): string {
  return typeof configFilePath === "string" ? configFilePath.replace(root, "") : "inferred";
}

function projectsReturnedFor(
  graph: TypeScriptProjectGraph,
  projectFixture: ConfiguredProjectFixture,
  target: string,
): readonly string[] {
  const root = `${projectFixture.root.replaceAll("\\", "/")}/`;
  return graph
    .sourceFilesFor(target)
    .map((sourceFile) =>
      configurationName(sourceFile.getProject().getCompilerOptions().configFilePath, root),
    )
    .sort();
}

function projectsWhoseProgramContains(
  graph: TypeScriptProjectGraph,
  snapshot: WorkspaceSnapshot,
  target: string,
): readonly string[] {
  const root = `${snapshot.root}/`;
  const programs = new Set(
    snapshot.files.flatMap((file) => {
      const program = graph.programFor(file.relative);
      return program ? [program] : [];
    }),
  );
  return [...programs]
    .filter((program) => program.getSourceFile(`${root}${target}`) !== undefined)
    .map((program) => configurationName(program.getCompilerOptions().configFilePath, root))
    .sort();
}

function writeResolutionEdgeProjects(projectFixture: ConfiguredProjectFixture): void {
  writeImporterProjects(projectFixture);
  const root = projectFixture.root.replaceAll("\\", "/");
  const ownConfiguration = JSON.stringify({ include: ["./**/*.ts"] });
  const consumers: Readonly<Record<string, string>> = {
    template: "export const loaded = import(`../../core/src/shared`);\n",
    absolute: `import { shared } from "${root}/core/src/shared";\nexport const value = shared();\n`,
    index: 'import { circle } from "../../shapes";\nexport const value = circle;\n',
  };
  for (const [name, source] of Object.entries(consumers)) {
    projectFixture.write(`ext/${name}/tsconfig.json`, ownConfiguration);
    projectFixture.write(`ext/${name}/use.ts`, source);
  }
  projectFixture.write("shapes/index.ts", "export const circle = 1;\n");
  projectFixture.write(
    "ext/base-url/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: "../.." }, include: ["./**/*.ts"] }),
  );
  projectFixture.write(
    "ext/base-url/use.ts",
    'import { shared } from "core/src/shared";\nexport const value = shared();\n',
  );
  projectFixture.write(
    "scratch/importer.ts",
    'import { shared } from "../core/src/shared";\nexport const value = shared();\n',
  );
  projectFixture.write("core/src/globals.d.ts", "declare function globalShared(): number;\n");
  projectFixture.write(
    "ext/types/tsconfig.json",
    JSON.stringify({
      compilerOptions: { types: ["../../core/src/globals"] },
      include: ["./**/*.ts"],
    }),
  );
  projectFixture.write("ext/types/use.ts", "export const value = globalShared();\n");
}

function writePackageImportsProject(projectFixture: ConfiguredProjectFixture): void {
  projectFixture.write(
    "package.json",
    JSON.stringify({
      name: "configured-project-cases",
      private: true,
      type: "module",
      imports: { "#core/*": "./core/src/*.ts" },
    }),
  );
  projectFixture.write(
    "ext/package-imports/tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "nodenext", moduleResolution: "nodenext" },
      include: ["./**/*.ts"],
    }),
  );
  projectFixture.write(
    "ext/package-imports/use.ts",
    'import { shared } from "#core/shared";\nexport const value = shared();\n',
  );
}

function importerProjectConfigurations(
  graph: TypeScriptProjectGraph,
  projectFixture: ConfiguredProjectFixture,
): readonly string[] {
  const root = `${projectFixture.root.replaceAll("\\", "/")}/`;
  return graph
    .sourceFilesFor("core/src/shared.ts")
    .map((sourceFile) =>
      String(sourceFile.getProject().getCompilerOptions().configFilePath).replace(root, ""),
    );
}

function writeImporterProjects(projectFixture: ConfiguredProjectFixture): void {
  const ownConfiguration = JSON.stringify({ include: ["./**/*.ts"] });
  projectFixture.write("tsconfig.json", JSON.stringify({ files: [] }));
  projectFixture.write("core/tsconfig.json", ownConfiguration);
  projectFixture.write("core/src/shared.ts", "export function shared(): number { return 1; }\n");
  projectFixture.write("core/src/bridge.ts", 'export { shared } from "./shared";\n');
  projectFixture.write("ext/relative/tsconfig.json", ownConfiguration);
  projectFixture.write(
    "ext/relative/use.ts",
    'import { shared } from "../../core/src/shared.js";\nexport const value = shared();\n',
  );
  projectFixture.write(
    "ext/alias/tsconfig.json",
    JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@core/*": ["../../core/src/*"] } },
      include: ["./**/*.ts"],
    }),
  );
  projectFixture.write(
    "ext/alias/use.ts",
    'import { shared } from "@core/shared";\nexport const value = shared();\n',
  );
  projectFixture.write("ext/transitive/tsconfig.json", ownConfiguration);
  projectFixture.write(
    "ext/transitive/use.ts",
    'import { shared } from "../../core/src/bridge";\nexport const value = shared();\n',
  );
  projectFixture.write("core/package.json", JSON.stringify({ types: "src/shared.ts" }));
  projectFixture.write("ext/package/tsconfig.json", ownConfiguration);
  projectFixture.write(
    "ext/package/use.ts",
    'import { shared } from "../../core";\nexport const value = shared();\n',
  );
  for (const name of ["unrelated", "other"]) {
    projectFixture.write(`ext/${name}/tsconfig.json`, ownConfiguration);
    projectFixture.write(
      `ext/${name}/local.ts`,
      'export function shared(): string { return "local"; }\n',
    );
  }
}

function writeSharedImportProjects(projectFixture: ConfiguredProjectFixture): void {
  projectFixture.write("core/shared.ts", "export function shared(): number { return 1; }\n");
  for (const [index, path] of sharedImportProjectFiles().entries()) {
    projectFixture.write(
      `ext/e${index}/tsconfig.json`,
      JSON.stringify({ compilerOptions: { strict: true }, include: ["./**/*.ts"] }),
    );
    projectFixture.write(
      path,
      'import { shared } from "../../core/shared";\nexport const value = shared();\n',
    );
  }
}

function sharedImportProjectFiles(): readonly string[] {
  return Array.from({ length: SHARED_IMPORT_PROJECT_COUNT }, (_, index) => `ext/e${index}/f.ts`);
}

async function calleeNames(
  backend: TypeScriptBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly string[]> {
  const callees = await backend.findCallees(files, identity);
  return callees.map((callee) => callee.symbol.identity.segments.at(-1)?.name ?? "");
}

function writeDeclarationTwinSources(
  projectFixture: ConfiguredProjectFixture,
  directory: string,
): void {
  projectFixture.write(`${directory}/Tabs.js`, "export function Tabs() {}\n");
  projectFixture.write(`${directory}/Tabs.d.ts`, "export declare function Tabs(): void;\n");
  projectFixture.write(
    `${directory}/App.ts`,
    'import { Tabs } from "./Tabs.js";\n\nexport const tabs = Tabs();\n',
  );
}

async function referencesOf(
  projectFixture: ConfiguredProjectFixture,
  identity: SymbolIdentity,
): Promise<readonly (string | number)[][]> {
  const snapshot = await projectFixture.snapshot();
  const backend = new TypeScriptBackend(projectFixture.fileSystem);
  await backend.refresh({
    snapshot,
    workspaceSnapshot: await projectFixture.workspaceSnapshot(),
    coverage: "workspace",
  });
  const references = await backend.findReferences(snapshot.files, identity);
  return references.map((reference) => [reference.file, reference.line, reference.kind]);
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
