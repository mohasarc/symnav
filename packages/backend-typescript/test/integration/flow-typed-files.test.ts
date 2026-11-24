import { describe, expect, it } from "vitest";
import {
  InMemoryFileSystem,
  UnsupportedFileError,
  type BackendRefreshCoverage,
  type SymbolIdentity,
  type WorkspaceFile,
} from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

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
});

class FlowWorkspace {
  readonly backend: TypeScriptBackend;
  private readonly contents: Record<string, string>;
  private readonly fileSystem: InMemoryFileSystem;

  constructor(sources: Readonly<Record<string, string>>) {
    this.contents = Object.fromEntries(
      Object.entries(sources).map(([relativePath, content]) => [`/repo/${relativePath}`, content]),
    );
    this.fileSystem = new InMemoryFileSystem(this.contents);
    this.backend = new TypeScriptBackend(this.fileSystem);
  }

  write(relativePath: string, content: string): void {
    this.contents[`/repo/${relativePath}`] = content;
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
