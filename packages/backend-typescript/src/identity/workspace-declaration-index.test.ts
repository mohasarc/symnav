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
    "export const handler = (): void => {};",
    "",
  ].join("\n"),
  "/repo/src/extra.ts": "export function extra(): void {}\n",
  "/repo/src/same-line.ts": "export function first(): void {} export function second(): void {}\n",
};

const SERVICE: ResolvedPath = { relative: "src/service.ts", absolute: "/repo/src/service.ts" };
const EXTRA: ResolvedPath = { relative: "src/extra.ts", absolute: "/repo/src/extra.ts" };
const SAME_LINE: ResolvedPath = {
  relative: "src/same-line.ts",
  absolute: "/repo/src/same-line.ts",
};

function index(files: readonly ResolvedPath[] = [SERVICE]): WorkspaceDeclarationIndex {
  const indexed = new WorkspaceDeclarationIndex(new InMemoryFileSystem(FIXTURE));
  indexed.ensureFiles(files);
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
  it("locates nested declarations by symbol identity", () => {
    const declarations = index().locate({
      file: "src/service.ts",
      segments: [{ name: "Service" }, { name: "run" }],
    });
    expect(declarations.map((declaration) => declaration.declaration.identity.segments)).toEqual([
      [{ name: "Service" }, { name: "run" }],
    ]);
  });

  it("finds workspace symbols for exact function, method, and variable declaration nodes", () => {
    const indexed = index();
    const sourceFile = indexed.sourceFile("src/service.ts")!;

    expect(indexed.declarationForNode(sourceFile.getFunctionOrThrow("helper"))?.identity).toEqual({
      file: "src/service.ts",
      segments: [{ name: "helper" }],
    });
    expect(
      indexed.declarationForNode(sourceFile.getClassOrThrow("Service").getMethodOrThrow("run"))
        ?.identity,
    ).toEqual({
      file: "src/service.ts",
      segments: [{ name: "Service" }, { name: "run" }],
    });
    expect(
      indexed.declarationForNode(sourceFile.getVariableDeclarationOrThrow("handler"))?.identity,
    ).toEqual({
      file: "src/service.ts",
      segments: [{ name: "handler" }],
    });
  });

  it("does not treat arbitrary same-start nodes as declarations", () => {
    const indexed = index();
    const sourceFile = indexed.sourceFile("src/service.ts")!;
    const run = sourceFile.getClassOrThrow("Service").getMethodOrThrow("run");
    const handler = sourceFile.getVariableDeclarationOrThrow("handler");

    expect(indexed.declarationForNode(sourceFile)).toBeUndefined();
    expect(indexed.declarationForNode(run.getBodyOrThrow())).toBeUndefined();
    expect(indexed.declarationForNode(handler.getVariableStatementOrThrow())).toBeUndefined();
    expect(indexed.declarationForNode(handler.getInitializerOrThrow())).toBeUndefined();
  });

  it("returns the workspace-relative path for indexed source files", () => {
    const fs = new InMemoryFileSystem(FIXTURE);
    const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
    const sourceFile = project.addSourceFileAtPath("/repo/src/service.ts");

    expect(index().relativePathOf(sourceFile)).toBe("src/service.ts");
  });

  it("ignores declaration nodes from files outside the workspace index", () => {
    const fs = new InMemoryFileSystem({
      ...FIXTURE,
      "/repo/src/outside.ts": "export function outside(): void {}\n",
    });
    const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
    const outside = project
      .addSourceFileAtPath("/repo/src/outside.ts")
      .getFunctionOrThrow("outside");

    expect(index().declarationForNode(outside)).toBeUndefined();
  });

  it("returns the flattened declaration list for an ensured file", () => {
    expect(leafNames(index().declarationsIn("src/service.ts")!)).toEqual([
      "Service",
      "run",
      "helper",
      "handler",
    ]);
  });

  it("returns undefined for a never-ensured file", () => {
    expect(index().declarationsIn("src/extra.ts")).toBeUndefined();
  });

  it("adds only new files on a second ensureFiles call and preserves existing lookups", () => {
    const indexed = index([SERVICE]);
    const serviceDeclarations = indexed.declarationsIn("src/service.ts");

    indexed.ensureFiles([SERVICE, EXTRA]);

    expect(indexed.declarationsIn("src/service.ts")).toBe(serviceDeclarations);
    expect(leafNames(indexed.declarationsIn("src/extra.ts")!)).toEqual(["extra"]);
    expect(indexed.locate({ file: "src/service.ts", segments: [{ name: "helper" }] })).toHaveLength(
      1,
    );
    expect(indexed.locate({ file: "src/extra.ts", segments: [{ name: "extra" }] })).toHaveLength(1);
  });

  it("keeps both declarations that start on the same line", () => {
    const indexed = index([SAME_LINE]);
    const sourceFile = indexed.sourceFile("src/same-line.ts")!;

    expect(indexed.declarationForNode(sourceFile.getFunctionOrThrow("first"))?.identity).toEqual({
      file: "src/same-line.ts",
      segments: [{ name: "first" }],
    });
    expect(indexed.declarationForNode(sourceFile.getFunctionOrThrow("second"))?.identity).toEqual({
      file: "src/same-line.ts",
      segments: [{ name: "second" }],
    });
  });
});
