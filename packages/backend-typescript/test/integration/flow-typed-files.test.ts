import { describe, expect, it } from "vitest";
import {
  InMemoryFileSystem,
  UnsupportedFileError,
  formatSymbolIdentity,
  type BackendRefreshCoverage,
  type SymbolIdentity,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";
import { TypeScriptProjectGraph } from "../../src/typescript-backend/typescript-project-graph.js";

describe("TypeScriptBackend Flow-typed files", () => {
  it("refuses a JavaScript file with a Flow pragma", async () => {
    const workspace = new FlowWorkspace({
      "src/flow.js": "// @flow\nexport function legacy() {}\n",
    });

    await workspace.refresh();

    const refusal = workspace.backend.refusal("src/flow.js");
    expect(refusal).toBeInstanceOf(UnsupportedFileError);
    expect(refusal?.reason).toBe("cannot read Flow-typed files (src/flow.js)");
  });

  it("answers JavaScript without a pragma and TypeScript with one", async () => {
    const workspace = new FlowWorkspace({
      "src/plain.js": "export function plain() {}\n",
      "src/typed.ts": "// @flow\nexport function typed() {}\n",
    });

    await workspace.refresh();

    expect(workspace.backend.refusal("src/plain.js")).toBeUndefined();
    expect(workspace.backend.refusal("src/typed.ts")).toBeUndefined();
  });

  it("re-evaluates the refusal when the file changes", async () => {
    const workspace = new FlowWorkspace({ "src/flow.js": "export function legacy() {}\n" });
    await workspace.refresh();
    expect(workspace.backend.refusal("src/flow.js")).toBeUndefined();

    workspace.write("src/flow.js", "/* @flow */\nexport function legacy() {}\n");
    await workspace.refresh();
    expect(workspace.backend.refusal("src/flow.js")).toBeInstanceOf(UnsupportedFileError);

    workspace.write("src/flow.js", "export function legacy() {}\n");
    await workspace.refresh();
    expect(workspace.backend.refusal("src/flow.js")).toBeUndefined();
  });

  it("keeps refusals of files outside a selection refresh", async () => {
    const workspace = new FlowWorkspace({
      "src/flow.js": "// @noflow\nexport function legacy() {}\n",
      "src/other.js": "// @flow\nexport function other() {}\n",
    });
    await workspace.refresh();

    workspace.write("src/other.js", "export function other() {}\n");
    await workspace.refresh("selection", ["src/other.js"]);

    expect(workspace.backend.refusal("src/flow.js")).toBeInstanceOf(UnsupportedFileError);
    expect(workspace.backend.refusal("src/other.js")).toBeUndefined();
  });

  it("leaves Flow-typed files out of declarations and resolved symbols", async () => {
    const workspace = new FlowWorkspace({
      "src/flow.js": "// @flow\nexport function legacy() {}\n",
      "src/plain.js": "export function legacy() {}\n",
    });
    const files = await workspace.refresh();

    const declarations = await workspace.backend.declarations(files);
    const resolved = await workspace.backend.resolveSymbols(files, "legacy", { mode: "exact" });

    expect(declarations.map((declaration) => declaration.identity.file)).toEqual(["src/plain.js"]);
    expect(resolved.map((symbol) => symbol.identity.file)).toEqual(["src/plain.js"]);
  });

  it("does not load a Flow-typed file passed to a semantic query", async () => {
    const workspace = new FlowWorkspace({
      "src/flow.js": "// @flow\nexport function legacy() {}\n",
    });
    const files = await workspace.refresh();
    const legacy: SymbolIdentity = { file: "src/flow.js", segments: [{ name: "legacy" }] };

    expect(await workspace.backend.findDefinitions(files, legacy)).toEqual([]);
  });

  it("refuses overview entries of a Flow-typed file", async () => {
    const workspace = new FlowWorkspace({
      "src/flow.js": "// @flow\nexport function legacy() {}\n",
    });
    const [flowFile] = await workspace.refresh();

    const error = await workspace.backend.fileEntries(flowFile!).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(UnsupportedFileError);
    expect((error as UnsupportedFileError).reason).toBe(
      "cannot read Flow-typed files (src/flow.js)",
    );
  });

  it("drops a file from declarations once it gains a Flow pragma", async () => {
    const workspace = new FlowWorkspace({ "src/flow.js": "export function legacy() {}\n" });
    const files = await workspace.refresh();
    expect(await workspace.backend.declarations(files)).toHaveLength(1);

    workspace.write("src/flow.js", "// @flow\nexport function legacy() {}\n");
    const changedFiles = await workspace.refresh();

    expect(await workspace.backend.declarations(changedFiles)).toEqual([]);
  });

  it("keeps Flow-typed files out of an importer's program", async () => {
    const workspace = new FlowWorkspace(FLOW_IMPORTER_SOURCES);

    await workspace.refresh();

    expect(workspace.programFileNames("src/app.ts")).toEqual([
      "/repo/src/app.ts",
      "/repo/src/util.ts",
    ]);
  });

  it("lands no reference, caller, or callee in a Flow-typed file", async () => {
    const workspace = new FlowWorkspace(FLOW_IMPORTER_SOURCES);
    const files = await workspace.refresh();
    const helper: SymbolIdentity = { file: "src/util.ts", segments: [{ name: "helper" }] };
    const app: SymbolIdentity = { file: "src/app.ts", segments: [{ name: "app" }] };

    const references = await workspace.backend.findReferences(files, helper);
    const callers = await workspace.backend.findCallers(files, helper);
    const callees = await workspace.backend.findCallees(files, app);

    expect(references.map((reference) => `${reference.file}:${reference.line}`)).toEqual([
      "src/app.ts:2",
      "src/app.ts:4",
    ]);
    expect(callers.map((edge) => formatSymbolIdentity(edge.symbol.identity))).toEqual([
      "src/app.ts::app",
    ]);
    expect(callees.map((edge) => formatSymbolIdentity(edge.symbol.identity))).toEqual([
      "src/util.ts::helper",
    ]);
  });

  it("loads a file into an importer's program again once it loses its Flow pragma", async () => {
    const workspace = new FlowWorkspace(FLOW_IMPORTER_SOURCES);
    await workspace.refresh();
    expect(workspace.programFileNames("src/app.ts")).not.toContain("/repo/src/flow.js");

    workspace.write("src/flow.js", "export function legacy() {}\n");
    await workspace.refresh();

    expect(workspace.programFileNames("src/app.ts")).toEqual([
      "/repo/src/app.ts",
      "/repo/src/flow.js",
      "/repo/src/util.ts",
    ]);
  });

  it("reads an unchanged Flow-typed file once across refreshes", async () => {
    const workspace = new FlowWorkspace({
      "src/flow.js": "// @flow\nexport function legacy() {}\n",
    });

    await workspace.refresh();
    await workspace.refresh();

    expect(workspace.readsOf("src/flow.js")).toBe(1);
  });
});

const FLOW_IMPORTER_SOURCES: Readonly<Record<string, string>> = {
  "src/flow.js":
    '// @flow\nimport { helper } from "./util";\nexport function legacy() {\n  return helper();\n}\n',
  "src/util.ts": "export function helper() {\n  return 1;\n}\n",
  "src/app.ts":
    'import { legacy } from "./flow";\nimport { helper } from "./util";\nexport function app() {\n  return [legacy(), helper()];\n}\n',
};

class ReadCountingFileSystem extends InMemoryFileSystem {
  readonly readPaths: string[] = [];

  override async readFile(absPath: string): Promise<string> {
    this.readPaths.push(absPath);
    return super.readFile(absPath);
  }

  override readFileSync(absPath: string): string {
    this.readPaths.push(absPath);
    return super.readFileSync(absPath);
  }
}

class FlowWorkspace {
  readonly backend: TypeScriptBackend;
  private readonly projectGraph: TypeScriptProjectGraph;
  private readonly contents: Record<string, string>;
  private readonly fileSystem: ReadCountingFileSystem;

  constructor(sources: Readonly<Record<string, string>>) {
    this.contents = Object.fromEntries(
      Object.entries(sources).map(([relativePath, content]) => [`/repo/${relativePath}`, content]),
    );
    this.fileSystem = new ReadCountingFileSystem(this.contents);
    this.projectGraph = new TypeScriptProjectGraph(this.fileSystem);
    this.backend = new TypeScriptBackend(this.fileSystem, undefined, this.projectGraph);
  }

  programFileNames(relativePath: string): readonly string[] {
    const program = this.projectGraph.programFor(relativePath);
    return (program?.getSourceFiles() ?? [])
      .map((sourceFile) => sourceFile.fileName)
      .filter((fileName) => fileName.startsWith("/repo/"))
      .sort();
  }

  write(relativePath: string, content: string): void {
    this.contents[`/repo/${relativePath}`] = content;
  }

  readsOf(relativePath: string): number {
    return this.fileSystem.readPaths.filter((path) => path === `/repo/${relativePath}`).length;
  }

  async refresh(
    coverage: BackendRefreshCoverage = "workspace",
    relativePaths: readonly string[] = this.relativePaths(),
  ): Promise<readonly WorkspaceFile[]> {
    const files = relativePaths.map((relative) => ({
      relative,
      absolute: `/repo/${relative}`,
      metadata: this.fileSystem.metadataSync(`/repo/${relative}`),
    }));
    await this.backend.refresh({ snapshot: { root: "/repo", files }, coverage });
    return files;
  }

  private relativePaths(): readonly string[] {
    return Object.keys(this.contents)
      .map((absolute) => absolute.slice("/repo/".length))
      .sort();
  }
}
