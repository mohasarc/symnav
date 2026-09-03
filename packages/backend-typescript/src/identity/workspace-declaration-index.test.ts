import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type ResolvedPath } from "@symnav/core";

import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";
import { WorkspaceDeclarationIndex } from "./workspace-declaration-index.js";

const FIXTURE: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/service.ts": [
    "export class Service {",
    "  run(): void {",
    "    helper();",
    "  }",
    "}",
    "",
    "export function helper(): void {}",
    "",
  ].join("\n"),
  "/repo/src/extra.ts": "export function extra(): void {}\n",
  "/repo/src/same-line.ts": "export function first(): void {} export function second(): void {}\n",
  "/repo/src/accessors.ts": [
    "export class Host {",
    "  private stored = 0;",
    "  get value(): number { return this.stored; }",
    "  set value(next: number) { this.stored = next; }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/default-export.ts": "export default () => {};\n",
};

const SERVICE: ResolvedPath = { relative: "src/service.ts", absolute: "/repo/src/service.ts" };
const EXTRA: ResolvedPath = { relative: "src/extra.ts", absolute: "/repo/src/extra.ts" };
const SAME_LINE: ResolvedPath = {
  relative: "src/same-line.ts",
  absolute: "/repo/src/same-line.ts",
};
const ACCESSORS: ResolvedPath = {
  relative: "src/accessors.ts",
  absolute: "/repo/src/accessors.ts",
};
const DEFAULT_EXPORT: ResolvedPath = {
  relative: "src/default-export.ts",
  absolute: "/repo/src/default-export.ts",
};

async function index(
  files: readonly ResolvedPath[] = [SERVICE],
): Promise<WorkspaceDeclarationIndex> {
  const indexed = new WorkspaceDeclarationIndex(new InMemoryFileSystem(FIXTURE));
  await indexed.ensureFiles(files);
  return indexed;
}

function leafNames(
  declarations: readonly { identity: { segments: readonly { name: string }[] } }[],
) {
  return declarations.map(
    (declaration) => declaration.identity.segments[declaration.identity.segments.length - 1]!.name,
  );
}

describe("WorkspaceDeclarationIndex", () => {
  it("locates nested declarations by symbol identity", async () => {
    const declarations = (await index()).locate({
      file: "src/service.ts",
      segments: [{ name: "Service" }, { name: "run" }],
    });
    expect(declarations.map((declaration) => declaration.declaration.identity.segments)).toEqual([
      [{ name: "Service" }, { name: "run" }],
    ]);
  });

  it("finds workspace symbols by declaration node location", async () => {
    const indexed = await index();
    const sourceFile = indexed.sourceFile("src/service.ts");
    const helperNode = sourceFile?.getFunctions().find((node) => node.getName() === "helper");
    expect(helperNode).toBeDefined();
    const declaration = indexed.declarationAt(helperNode!);
    expect(declaration?.identity).toEqual({
      file: "src/service.ts",
      segments: [{ name: "helper" }],
    });
  });

  it("returns the workspace-relative path for indexed source files", async () => {
    const fs = new InMemoryFileSystem(FIXTURE);
    const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
    const sourceFile = project.addSourceFileAtPath("/repo/src/service.ts");

    expect((await index()).relativePathOf(sourceFile)).toBe("src/service.ts");
  });

  it("ignores declaration nodes from files outside the workspace index", async () => {
    const fs = new InMemoryFileSystem({
      ...FIXTURE,
      "/repo/src/outside.ts": "export function outside(): void {}\n",
    });
    const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
    const outside = project
      .addSourceFileAtPath("/repo/src/outside.ts")
      .getFunctionOrThrow("outside");

    expect((await index()).declarationAt(outside)).toBeUndefined();
  });

  it("returns the flattened declaration list for an ensured file", async () => {
    expect(leafNames((await index()).declarationsIn("src/service.ts")!)).toEqual([
      "Service",
      "run",
      "helper",
    ]);
  });

  it("returns undefined for a never-ensured file", async () => {
    expect((await index()).declarationsIn("src/extra.ts")).toBeUndefined();
  });

  it("adds only new files on a second ensureFiles call and preserves existing lookups", async () => {
    const indexed = await index([SERVICE]);
    const serviceDeclarations = indexed.declarationsIn("src/service.ts");

    await indexed.ensureFiles([SERVICE, EXTRA]);

    expect(indexed.declarationsIn("src/service.ts")).toBe(serviceDeclarations);
    expect(leafNames(indexed.declarationsIn("src/extra.ts")!)).toEqual(["extra"]);
    expect(indexed.locate({ file: "src/service.ts", segments: [{ name: "helper" }] })).toHaveLength(
      1,
    );
    expect(indexed.locate({ file: "src/extra.ts", segments: [{ name: "extra" }] })).toHaveLength(1);
  });

  it("keeps both declarations that start on the same line", async () => {
    expect(leafNames((await index([SAME_LINE])).declarationsIn("src/same-line.ts")!)).toEqual([
      "first",
      "second",
    ]);
  });

  it("finds each declaration node when two declarations start on the same line", async () => {
    const indexed = await index([SAME_LINE]);
    const functions = indexed.sourceFile("src/same-line.ts")!.getFunctions();

    expect(indexed.declarationAt(functions[0]!)?.identity.segments).toEqual([{ name: "first" }]);
    expect(indexed.declarationAt(functions[1]!)?.identity.segments).toEqual([{ name: "second" }]);
  });

  it("finds getter and setter symbols by their exact declaration nodes", async () => {
    const indexed = await index([ACCESSORS]);
    const host = indexed.sourceFile("src/accessors.ts")!.getClassOrThrow("Host");

    expect(indexed.declarationAt(host.getGetAccessorOrThrow("value"))?.kind.nativeLabel).toBe(
      "getter",
    );
    expect(indexed.declarationAt(host.getSetAccessorOrThrow("value"))?.kind.nativeLabel).toBe(
      "setter",
    );
  });

  it("finds a default export assignment by its declaration node", async () => {
    const indexed = await index([DEFAULT_EXPORT]);
    const exportAssignment = indexed
      .sourceFile("src/default-export.ts")!
      .getExportAssignmentOrThrow(() => true);

    expect(leafNames([indexed.declarationAt(exportAssignment)!])).toEqual(["default"]);
  });
});
