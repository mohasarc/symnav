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
import { ts } from "ts-morph";

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

  it("discovers a nested configuration created later without source changes", async () => {
    const projectFixture = fixture();
    const domainConfigurationPath = join(projectFixture.root, "packages/domain/tsconfig.json");
    const domainConfiguration = readFileSync(domainConfigurationPath, "utf8");
    projectFixture.write("tsconfig.json", JSON.stringify({ files: [] }));
    projectFixture.remove("packages/domain/tsconfig.json");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    const before = await graph.refresh(snapshot);

    projectFixture.write("packages/domain/tsconfig.json", domainConfiguration);
    const after = await graph.refresh(snapshot);

    expect(after.configuredProjectCount).toBe(before.configuredProjectCount + 1);
    expect(after.changedConfigurationCount).toBe(1);
  });

  it("drops a nested configuration deleted later without source changes", async () => {
    const projectFixture = fixture();
    const root = projectFixture.root.replaceAll("\\", "/");
    projectFixture.write("tsconfig.json", JSON.stringify({ files: [] }));
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    const before = await graph.refresh(snapshot);

    projectFixture.remove("packages/domain/tsconfig.json");
    const after = await graph.refresh(snapshot);
    const domainOptions = graph.programFor("packages/domain/src/local.ts")?.getCompilerOptions();

    expect(after.configuredProjectCount).toBe(before.configuredProjectCount - 1);
    expect(after.inferredFileCount).toBe(before.inferredFileCount + 5);
    expect(domainOptions?.baseUrl).toBe(root);
  });

  it("discovers a previously missing workspace package without source changes", async () => {
    const projectFixture = fixture();
    const packagePath = join(projectFixture.root, "packages/domain/package.json");
    const packageContent = readFileSync(packagePath, "utf8");
    projectFixture.remove("packages/domain/package.json");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    const before = await graph.refresh(snapshot);

    projectFixture.write("packages/domain/package.json", packageContent);
    const after = await graph.refresh(snapshot);
    const paths = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().paths;

    expect(before.changedConfigurationCount).toBe(5);
    expect(after.changedConfigurationCount).toBe(1);
    expect(paths?.["@configured/domain"]).toEqual([
      `${projectFixture.root.replaceAll("\\", "/")}/packages/domain/src/index.ts`,
    ]);
  });

  it("stops observing configuration inputs after they become unreachable", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({
        files: [],
        references: [{ path: "packages/domain" }, { path: "packages/app/tsconfig.build.json" }],
      }),
    );
    projectFixture.write(
      "packages/app/tsconfig.build.json",
      JSON.stringify({ include: ["src/index.ts"] }),
    );
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot());
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({ files: [], references: [{ path: "packages/domain" }] }),
    );
    const narrowedSnapshot = await projectFixture.snapshot();
    const narrowed = await graph.refresh(narrowedSnapshot);
    const narrowedService = graph.languageServiceFor("packages/app/src/index.ts");

    projectFixture.write(
      "packages/app/tsconfig.build.json",
      JSON.stringify({ include: ["src/index.ts"], compilerOptions: { strict: true } }),
    );
    const unchanged = await graph.refresh(narrowedSnapshot);

    expect(narrowed.changedConfigurationCount).toBe(2);
    expect(unchanged.changedConfigurationCount).toBe(0);
    expect(graph.languageServiceFor("packages/app/src/index.ts")).toBe(narrowedService);
  });

  it("orders every owning project and uses the last owner as primary", async () => {
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
    await graph.refresh(await projectFixture.snapshot());

    const sourceFiles = graph.sourceFilesFor("packages/domain/src/index.ts");
    const primary = graph.sourceFileFor("packages/domain/src/index.ts");

    expect(
      sourceFiles.map((sourceFile) => sourceFile.getProject().getCompilerOptions().baseUrl),
    ).toEqual([
      projectFixture.root.replaceAll("\\", "/") + "/packages/app",
      projectFixture.root.replaceAll("\\", "/") + "/packages/domain",
    ]);
    expect(primary).toBe(sourceFiles.at(-1));
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

    expect(referencesChanged.configuredProjectCount).toBe(3);
    expect(referencesChanged.inferredFileCount).toBe(1);
    expect(referencesChanged.changedConfigurationCount).toBe(1);
    expect(referencedOptions?.paths?.["@changed/*"]).toBeDefined();
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

  it.each(["./src/**/*.ts", "../domain/src/**/*.ts"])(
    "owns files named by inherited include spec %s",
    async (includeSpec) => {
      const projectFixture = fixture();
      projectFixture.write(
        "tsconfig.json",
        JSON.stringify({ extends: "./packages/domain/tsconfig.shared.json" }),
      );
      projectFixture.remove("packages/domain/tsconfig.json");
      projectFixture.write(
        "packages/domain/tsconfig.shared.json",
        JSON.stringify({ compilerOptions: { baseUrl: "." }, include: [includeSpec] }),
      );
      const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

      const refresh = await graph.refresh(await projectFixture.snapshot());
      const owner = graph.sourceFileFor("packages/domain/src/index.ts");

      expect(refresh.configuredProjectCount).toBe(2);
      expect(refresh.inferredFileCount).toBe(1);
      expect(owner?.getProject().getCompilerOptions().baseUrl).toBe(
        `${projectFixture.root.replaceAll("\\", "/")}/packages/domain`,
      );
    },
  );

  it("leaves out files named by an inherited exclude spec", async () => {
    const projectFixture = fixture();
    const root = projectFixture.root.replaceAll("\\", "/");
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({ extends: "./packages/domain/tsconfig.shared.json" }),
    );
    projectFixture.remove("packages/domain/tsconfig.json");
    projectFixture.write(
      "packages/domain/tsconfig.shared.json",
      JSON.stringify({
        compilerOptions: { baseUrl: "." },
        include: ["./src/**/*.ts"],
        exclude: ["./src/features/**"],
      }),
    );
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);

    const refresh = await graph.refresh(await projectFixture.snapshot());
    const includedOwner = graph.sourceFileFor("packages/domain/src/index.ts");
    const excludedOwner = graph.sourceFileFor("packages/domain/src/features/patterned.ts");

    expect(refresh.inferredFileCount).toBe(2);
    expect(includedOwner?.getProject().getCompilerOptions().baseUrl).toBe(
      `${root}/packages/domain`,
    );
    expect(excludedOwner?.getProject().getCompilerOptions().baseUrl).toBe(root);
  });

  it("resolves path aliases through an inherited configuration", async () => {
    const projectFixture = fixture();
    projectFixture.write(
      "tsconfig.json",
      JSON.stringify({ extends: "./packages/app/tsconfig.shared.json" }),
    );
    projectFixture.remove("packages/app/tsconfig.json");
    projectFixture.write(
      "packages/app/tsconfig.shared.json",
      JSON.stringify({ extends: "./tsconfig.base.json", include: ["./src/**/*.ts"] }),
    );
    const backend = new TypeScriptBackend(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    await backend.refresh({ snapshot, coverage: "workspace" });
    const app = symbolIdentity("packages/app/src/index.ts", "useConfiguredImports");

    expect(await calleeNames(backend, snapshot.files, app)).toEqual([
      "workspaceTarget",
      "pathTarget",
    ]);
  });

  it("discovers package configurations when the root configuration is malformed or missing", async () => {
    const projectFixture = fixture();
    const root = projectFixture.root.replaceAll("\\", "/");
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    projectFixture.write("tsconfig.json", "{ malformed");

    const malformed = await graph.refresh(await projectFixture.snapshot());
    projectFixture.remove("tsconfig.json");
    const missing = await graph.refresh(await projectFixture.snapshot());
    const appPaths = graph.programFor("packages/app/src/index.ts")?.getCompilerOptions().paths;

    expect(malformed.configuredProjectCount).toBe(2);
    expect(malformed.inferredFileCount).toBe(1);
    expect(missing.configuredProjectCount).toBe(2);
    expect(missing.inferredFileCount).toBe(1);
    expect(appPaths?.["@local/*"]).toEqual([`${root}/packages/app/src/*`]);
    expect(graph.languageServiceFor("scratch/outside.ts")).toBeDefined();
  });

  it("uses the deepest owning configuration as primary over an including ancestor", async () => {
    const projectFixture = fixture();
    const root = projectFixture.root.replaceAll("\\", "/");
    projectFixture.write("tsconfig.json", JSON.stringify({ include: ["**/*.ts"] }));
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot());

    const sourceFiles = graph.sourceFilesFor("packages/domain/src/index.ts");
    const primary = graph.sourceFileFor("packages/domain/src/index.ts");

    expect(sourceFiles[0]?.getProject().getCompilerOptions().baseUrl).toBe(root);
    expect(primary?.getProject().getCompilerOptions().baseUrl).toBe(`${root}/packages/domain`);
    expect(primary).toBe(sourceFiles.at(-1));
  });

  it("orders nested configurations shallow to deep and uses the deepest as primary", async () => {
    const projectFixture = fixture();
    const root = projectFixture.root.replaceAll("\\", "/");
    projectFixture.write(
      "packages/app/src/tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["**/*.ts"] }),
    );
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot());

    const sourceFiles = graph.sourceFilesFor("packages/app/src/local.ts");
    const primary = graph.sourceFileFor("packages/app/src/local.ts");

    expect(
      sourceFiles.map((sourceFile) => sourceFile.getProject().getCompilerOptions().baseUrl),
    ).toEqual([`${root}/packages/app`, `${root}/packages/app/src`]);
    expect(primary).toBe(sourceFiles.at(-1));
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

  it("loads uncovered JavaScript files into the inferred project with JavaScript defaults", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/tabs.js": "export function createTabs(label) { return label; }\n",
      "/repo/src/use.ts": 'import { createTabs } from "./tabs.js";\ncreateTabs("home");\n',
    });
    const files = ["src/tabs.js", "src/use.ts"].map((relative) => ({
      relative,
      absolute: `/repo/${relative}`,
      metadata: fileSystem.metadataSync(`/repo/${relative}`),
    }));
    const graph = new TypeScriptProjectGraph(fileSystem);

    await graph.refresh({ root: "/repo", files });

    const program = graph.programFor("src/tabs.js");
    expect(program?.getSourceFile("/repo/src/tabs.js")).toBeDefined();
    expect(program?.getCompilerOptions()).toMatchObject({
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      checkJs: false,
      maxNodeModuleJsDepth: 0,
    });
    expect(program?.getCompilerOptions().module).toBeUndefined();
    expect(program?.getCompilerOptions().moduleResolution).toBeUndefined();
  });

  it("keeps untyped node_modules JavaScript out of the inferred project", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/node_modules/untyped/package.json": JSON.stringify({ name: "untyped" }),
      "/repo/node_modules/untyped/index.js": "exports.untypedHelper = function () {};\n",
      "/repo/src/use.ts": 'import { untypedHelper } from "untyped";\nuntypedHelper();\n',
    });
    const files = [
      {
        relative: "src/use.ts",
        absolute: "/repo/src/use.ts",
        metadata: fileSystem.metadataSync("/repo/src/use.ts"),
      },
    ];
    const graph = new TypeScriptProjectGraph(fileSystem);

    await graph.refresh({ root: "/repo", files });

    const program = graph.programFor("src/use.ts");
    expect(program?.getSourceFile("/repo/src/use.ts")).toBeDefined();
    expect(program?.getSourceFile("/repo/node_modules/untyped/index.js")).toBeUndefined();
  });

  it("owns covered JavaScript in a configuration without allowJs and forces allowJs on", async () => {
    const workspace = inMemoryWorkspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
        include: ["src", "lib"],
      }),
      "lib/helper.ts": "export function helper(): number { return 1; }\n",
      "src/b.js":
        'import { helper } from "@lib/helper";\nexport function useHelper() { return helper(); }\n',
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);
    const backend = new TypeScriptBackend(workspace.fileSystem);
    await backend.refresh({ snapshot: workspace.snapshot, coverage: "workspace" });

    const refresh = await graph.refresh(workspace.snapshot);
    const options = graph.programFor("src/b.js")?.getCompilerOptions();
    const callees = await calleeNames(
      backend,
      workspace.snapshot.files,
      symbolIdentity("src/b.js", "useHelper"),
    );

    expect(refresh.inferredFileCount).toBe(0);
    expect(options).toMatchObject({ allowJs: true, maxNodeModuleJsDepth: 0, strict: true });
    expect(options?.paths?.["@lib/*"]).toEqual(["/repo/lib/*"]);
    expect(callees).toEqual(["helper"]);
  });

  it("forces allowJs on for a configuration that disables it but covers JavaScript", async () => {
    const workspace = inMemoryWorkspace({
      "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: false } }),
      "src/a.ts": "export const a = 1;\n",
      "src/b.js": "export function b() {}\n",
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);
    const program = graph.programFor("src/b.js");

    expect(refresh.inferredFileCount).toBe(0);
    expect(program?.getSourceFile("/repo/src/a.ts")).toBeDefined();
    expect(program?.getSourceFile("/repo/src/b.js")).toBeDefined();
    expect(program?.getCompilerOptions()).toMatchObject({ allowJs: true, maxNodeModuleJsDepth: 0 });
  });

  it("forces allowJs on for JavaScript listed in files", async () => {
    const workspace = inMemoryWorkspace({
      "tsconfig.json": JSON.stringify({ files: ["src/b.js"] }),
      "src/b.js": "export function b() {}\n",
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);
    const program = graph.programFor("src/b.js");

    expect(refresh.inferredFileCount).toBe(0);
    expect(program?.getSourceFile("/repo/src/b.js")).toBeDefined();
    expect(program?.getCompilerOptions()).toMatchObject({ allowJs: true, maxNodeModuleJsDepth: 0 });
  });

  it("owns covered JavaScript in a nested configuration without allowJs", async () => {
    const workspace = inMemoryWorkspace({
      "packages/a/tsconfig.json": JSON.stringify({ include: ["src"] }),
      "packages/a/src/x.js": "export function x() {}\n",
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);
    const program = graph.programFor("packages/a/src/x.js");

    expect(refresh.configuredProjectCount).toBe(1);
    expect(refresh.inferredFileCount).toBe(0);
    expect(program?.getSourceFile("/repo/packages/a/src/x.js")).toBeDefined();
    expect(program?.getCompilerOptions()).toMatchObject({ allowJs: true, maxNodeModuleJsDepth: 0 });
  });

  it.each([
    ["src/Tabs.js", "src/Tabs.d.ts"],
    ["src/Tabs.jsx", "src/Tabs.d.ts"],
    ["src/tabs.mjs", "src/tabs.d.mts"],
    ["src/tabs.cjs", "src/tabs.d.cts"],
    ["src/tabs.js", "src/tabs.ts"],
  ])(
    "owns %s beside %s in one allowJs configuration program",
    async (javascriptPath, typeScriptPath) => {
      const workspace = inMemoryWorkspace({
        "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true } }),
        [javascriptPath]: "export function tabs() {}\n",
        [typeScriptPath]: "export declare function tabs(): void;\n",
      });
      const graph = new TypeScriptProjectGraph(workspace.fileSystem);

      const refresh = await graph.refresh(workspace.snapshot);
      const program = graph.programFor(javascriptPath);

      expect(refresh.inferredFileCount).toBe(0);
      expect(program?.getSourceFile(`/repo/${javascriptPath}`)).toBeDefined();
      expect(program?.getSourceFile(`/repo/${typeScriptPath}`)).toBeDefined();
      expect(graph.programFor(typeScriptPath)).toBe(program);
    },
  );

  it.each([
    [
      "directly",
      { "tsconfig.json": JSON.stringify({ compilerOptions: { maxNodeModuleJsDepth: 3 } }) },
    ],
    [
      "through extends",
      {
        "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
        "tsconfig.base.json": JSON.stringify({ compilerOptions: { maxNodeModuleJsDepth: 3 } }),
      },
    ],
  ])("honors a maxNodeModuleJsDepth configured %s for covered JavaScript", async (_, configs) => {
    const workspace = inMemoryWorkspace({ ...configs, "src/b.js": "export function b() {}\n" });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    await graph.refresh(workspace.snapshot);

    expect(graph.programFor("src/b.js")?.getCompilerOptions()).toMatchObject({
      allowJs: true,
      maxNodeModuleJsDepth: 3,
    });
  });

  it.each([
    ["an include of TypeScript only", { include: ["src/**/*.ts"] }],
    ["files only", { files: ["src/a.ts"] }],
  ])(
    "keeps compiler options and leaves JavaScript inferred for a configuration with %s",
    async (_, configuration) => {
      const workspace = inMemoryWorkspace({
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, ...configuration }),
        "src/a.ts": "export const a = 1;\n",
        "src/b.js": "export function b() {}\n",
      });
      const graph = new TypeScriptProjectGraph(workspace.fileSystem);

      const refresh = await graph.refresh(workspace.snapshot);
      const options = graph.programFor("src/a.ts")?.getCompilerOptions();
      const javascriptProgram = graph.programFor("src/b.js");

      expect(refresh.inferredFileCount).toBe(1);
      expect(options?.strict).toBe(true);
      expect(options?.allowJs).toBeUndefined();
      expect(options?.maxNodeModuleJsDepth).toBeUndefined();
      expect(javascriptProgram?.getCompilerOptions().strict).toBeUndefined();
    },
  );

  it("keeps compiler options of a configuration listing JavaScript outside the snapshot", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/tsconfig.json": JSON.stringify({ files: ["src/a.ts", "src/b.js"] }),
      "/repo/src/a.ts": 'import { b } from "./b.js";\nexport const a = b();\n',
      "/repo/src/b.js": "export function b() {}\n",
    });
    const files = [
      {
        relative: "src/a.ts",
        absolute: "/repo/src/a.ts",
        metadata: fileSystem.metadataSync("/repo/src/a.ts"),
      },
    ];
    const graph = new TypeScriptProjectGraph(fileSystem);

    await graph.refresh({ root: "/repo", files });
    const options = graph.programFor("src/a.ts")?.getCompilerOptions();

    expect(options?.allowJs).toBeUndefined();
    expect(options?.maxNodeModuleJsDepth).toBeUndefined();
  });

  it("owns JavaScript in a root jsconfig.json project with TypeScript's jsconfig defaults", async () => {
    const workspace = inMemoryWorkspace({
      "jsconfig.json": JSON.stringify({}),
      "src/a.js": "export function a() {}\n",
      "src/b.js": 'import { a } from "./a.js";\nexport function b() { return a(); }\n',
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);
    const program = graph.programFor("src/b.js");

    expect(refresh.configuredProjectCount).toBe(1);
    expect(refresh.inferredFileCount).toBe(0);
    expect(graph.programFor("src/a.js")).toBe(program);
    expect(program?.getCompilerOptions()).toMatchObject({
      allowJs: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true,
      noEmit: true,
      maxNodeModuleJsDepth: 2,
    });
  });

  it("owns TypeScript a root jsconfig.json covers and resolves its path aliases", async () => {
    const workspace = inMemoryWorkspace({
      "jsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
      }),
      "lib/helper.ts": "export function helper(): number { return 1; }\n",
      "src/use.ts":
        'import { helper } from "@lib/helper";\nexport function useHelper() { return helper(); }\n',
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);
    const backend = new TypeScriptBackend(workspace.fileSystem);
    await backend.refresh({ snapshot: workspace.snapshot, coverage: "workspace" });

    const refresh = await graph.refresh(workspace.snapshot);
    const callees = await calleeNames(
      backend,
      workspace.snapshot.files,
      symbolIdentity("src/use.ts", "useHelper"),
    );

    expect(refresh.configuredProjectCount).toBe(1);
    expect(refresh.inferredFileCount).toBe(0);
    expect(callees).toEqual(["helper"]);
  });

  it("uses only the tsconfig.json when a jsconfig.json shares its directory", async () => {
    const workspace = inMemoryWorkspace({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "jsconfig.json": JSON.stringify({}),
      "src/a.ts": "export const a = 1;\n",
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);
    const options = graph.programFor("src/a.ts")?.getCompilerOptions();

    expect(refresh.configuredProjectCount).toBe(1);
    expect(options?.strict).toBe(true);
    expect(options?.skipLibCheck).toBeUndefined();
  });

  it("switches between jsconfig.json and tsconfig.json as a sibling tsconfig.json comes and goes", async () => {
    const projectFixture = fixture();
    projectFixture.write("scratch/jsconfig.json", JSON.stringify({}));
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    const snapshot = await projectFixture.snapshot();
    const scratchOptions = () => graph.programFor("scratch/outside.ts")?.getCompilerOptions();

    const withJavaScriptConfiguration = await graph.refresh(snapshot);
    const javaScriptOptions = scratchOptions();
    projectFixture.write(
      "scratch/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const withTypeScriptConfiguration = await graph.refresh(snapshot);
    const typeScriptOptions = scratchOptions();
    projectFixture.remove("scratch/tsconfig.json");
    const restored = await graph.refresh(snapshot);

    expect(withJavaScriptConfiguration.inferredFileCount).toBe(0);
    expect(javaScriptOptions?.skipLibCheck).toBe(true);
    expect(withTypeScriptConfiguration.configuredProjectCount).toBe(
      withJavaScriptConfiguration.configuredProjectCount,
    );
    expect(typeScriptOptions).toMatchObject({ strict: true });
    expect(typeScriptOptions?.skipLibCheck).toBeUndefined();
    expect(restored.configuredProjectCount).toBe(
      withJavaScriptConfiguration.configuredProjectCount,
    );
    expect(scratchOptions()?.skipLibCheck).toBe(true);
  });

  it("makes a nested jsconfig.json primary for TypeScript under it over an ancestor tsconfig.json", async () => {
    const workspace = inMemoryWorkspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@x/*": ["src/*"] } },
      }),
      "docs/jsconfig.json": JSON.stringify({}),
      "src/x.ts": "export function x(): number { return 1; }\n",
      "docs/demo.ts": 'import { x } from "@x/x";\nexport function demo() { return x(); }\n',
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);
    const backend = new TypeScriptBackend(workspace.fileSystem);
    await backend.refresh({ snapshot: workspace.snapshot, coverage: "workspace" });

    const refresh = await graph.refresh(workspace.snapshot);
    const options = graph.programFor("docs/demo.ts")?.getCompilerOptions();
    const callees = await calleeNames(
      backend,
      workspace.snapshot.files,
      symbolIdentity("docs/demo.ts", "demo"),
    );

    expect(refresh.configuredProjectCount).toBe(2);
    expect(options?.skipLibCheck).toBe(true);
    expect(options?.paths?.["@x/*"]).toBeUndefined();
    expect(callees).toEqual([]);
  });

  it("discovers a nested jsconfig.json without a root configuration", async () => {
    const workspace = inMemoryWorkspace({
      "packages/a/jsconfig.json": JSON.stringify({}),
      "packages/a/src/x.js": "export function x() {}\n",
      "scratch/y.js": "export function y() {}\n",
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);
    const program = graph.programFor("packages/a/src/x.js");

    expect(refresh.configuredProjectCount).toBe(1);
    expect(refresh.inferredFileCount).toBe(1);
    expect(program?.getSourceFile("/repo/packages/a/src/x.js")).toBeDefined();
    expect(program?.getCompilerOptions()).toMatchObject({ skipLibCheck: true });
  });

  it("applies options a jsconfig.json extends from a base jsconfig", async () => {
    const workspace = inMemoryWorkspace({
      "jsconfig.json": JSON.stringify({ extends: "./jsconfig.base.json" }),
      "jsconfig.base.json": JSON.stringify({ compilerOptions: { checkJs: true } }),
      "src/b.js": "export function b() {}\n",
    });
    const graph = new TypeScriptProjectGraph(workspace.fileSystem);

    const refresh = await graph.refresh(workspace.snapshot);

    expect(refresh.configuredProjectCount).toBe(1);
    expect(graph.programFor("src/b.js")?.getCompilerOptions()).toMatchObject({
      checkJs: true,
      skipLibCheck: true,
    });
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

  it("parses a shared file separately for configurations with different targets", async () => {
    const projectFixture = fixture();
    const sharedPath = `${projectFixture.root.replaceAll("\\", "/")}/core/shared.ts`;
    projectFixture.write("core/shared.ts", "export function shared(): number { return 1; }\n");
    for (const target of ["ES5", "ES2022"]) {
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
    await graph.refresh(await projectFixture.snapshot());

    const olderTargetShared = graph.programFor("ext/ES5/f.ts")?.getSourceFile(sharedPath);
    const newerTargetShared = graph.programFor("ext/ES2022/f.ts")?.getSourceFile(sharedPath);

    expect(olderTargetShared).toBeDefined();
    expect(newerTargetShared).toBeDefined();
    expect(newerTargetShared).not.toBe(olderTargetShared);
  });

  it("parses shared and default library files once across many configured projects", async () => {
    const projectFixture = fixture();
    writeSharedImportProjects(projectFixture);
    const graph = new TypeScriptProjectGraph(projectFixture.fileSystem);
    await graph.refresh(await projectFixture.snapshot());

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
    await graph.refresh(await projectFixture.snapshot());
    const [path] = sharedImportProjectFiles();
    const sharedPath = `${projectFixture.root.replaceAll("\\", "/")}/core/shared.ts`;
    const beforeRelease = graph.programFor(path!)?.getSourceFile(sharedPath);

    await graph.releaseTransientResources();
    const afterRelease = graph.programFor(path!)?.getSourceFile(sharedPath);

    expect(beforeRelease).toBeDefined();
    expect(afterRelease).toBeDefined();
    expect(afterRelease).not.toBe(beforeRelease);
  });
});

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

function inMemoryWorkspace(sources: Readonly<Record<string, string>>): {
  readonly fileSystem: InMemoryFileSystem;
  readonly snapshot: WorkspaceSnapshot;
} {
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
  return { fileSystem, snapshot: { root: "/repo", files } };
}

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
