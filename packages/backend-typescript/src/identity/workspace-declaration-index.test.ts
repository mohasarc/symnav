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
};

const FILES: readonly ResolvedPath[] = [
  { relative: "src/service.ts", absolute: "/repo/src/service.ts" },
];

function index(): WorkspaceDeclarationIndex {
  return new WorkspaceDeclarationIndex({
    fs: new InMemoryFileSystem(FIXTURE),
    files: FILES,
  });
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

  it("finds workspace symbols by declaration node location", () => {
    const indexed = index();
    const sourceFile = indexed.sourceFile("src/service.ts");
    const helperNode = sourceFile?.getFunctions().find((node) => node.getName() === "helper");
    expect(helperNode).toBeDefined();
    const declaration = indexed.declarationAt(helperNode!);
    expect(declaration?.identity).toEqual({
      file: "src/service.ts",
      segments: [{ name: "helper" }],
    });
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

    expect(index().declarationAt(outside)).toBeUndefined();
  });
});
