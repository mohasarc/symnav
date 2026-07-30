import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type ResolvedPath, type SymbolOverviewNode } from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

const CALL_GRAPH_CASES: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/plain.ts": [
    "export function greet(name: string): string {",
    "  return `hi ${name}`;",
    "}",
    "",
  ].join("\n"),
  "/repo/src/overloaded.ts": [
    "export class Formatter {",
    "  format(value: string): string;",
    "  format(value: number): string;",
    "  format(value: string | number): string {",
    "    return String(value);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/contract/Shape.ts": ["export interface Shape {", "  area(): number;", "}", ""].join(
    "\n",
  ),
  "/repo/src/contract/Drawable.ts": [
    "export interface Drawable {",
    "  render(): string;",
    "}",
    "",
  ].join("\n"),
  "/repo/src/contract/Circle.ts": [
    'import type { Shape } from "./Shape.js";',
    "",
    "export class Circle implements Shape {",
    "  area(): number {",
    "    return 3.14;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/contract/Square.ts": [
    'import type { Shape } from "./Shape.js";',
    "",
    "export class Square implements Shape {",
    "  area(): number {",
    "    return 4;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/contract/Service.ts": ["export interface Service {", "  run(): void;", "}", ""].join(
    "\n",
  ),
  "/repo/src/contract/ConcreteService.ts": [
    'import type { Service } from "./Service.js";',
    "",
    "function helper(): void {}",
    "",
    "export class ConcreteService implements Service {",
    "  run(): void {",
    "    helper();",
    "  }",
    "}",
    "",
  ].join("\n"),
};

const ALL_FILES: readonly ResolvedPath[] = [
  "src/contract/Circle.ts",
  "src/contract/ConcreteService.ts",
  "src/contract/Drawable.ts",
  "src/contract/Service.ts",
  "src/contract/Shape.ts",
  "src/contract/Square.ts",
  "src/overloaded.ts",
  "src/plain.ts",
].map((relative) => ({ relative, absolute: `/repo/${relative}` }));

function backend(): TypeScriptBackend {
  return new TypeScriptBackend(new InMemoryFileSystem(CALL_GRAPH_CASES));
}

function leafLabel(decl: SymbolOverviewNode): string {
  return decl.kind.nativeLabel;
}

describe("TypeScriptBackend.findCallTarget", () => {
  it("resolves a plain function to its declaration", async () => {
    const resolution = await backend().findCallTarget(ALL_FILES, {
      file: "src/plain.ts",
      segments: [{ name: "greet" }],
    });
    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.target.identity.file).toBe("src/plain.ts");
    expect(leafLabel(resolution.target)).toBe("function-implementation");
    expect(resolution.target.range.startLine).toBe(1);
  });

  it("collapses an overloaded method to its implementation declaration", async () => {
    const resolution = await backend().findCallTarget(ALL_FILES, {
      file: "src/overloaded.ts",
      segments: [{ name: "Formatter" }, { name: "format" }],
    });
    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(leafLabel(resolution.target)).toBe("method-implementation");
    expect(resolution.target.range.endLine).toBeGreaterThan(resolution.target.range.startLine);
  });

  it("reports an interface method with two implementations as ambiguous", async () => {
    const resolution = await backend().findCallTarget(ALL_FILES, {
      file: "src/contract/Shape.ts",
      segments: [{ name: "Shape" }, { name: "area" }],
    });
    expect(resolution.outcome).toBe("ambiguous");
    if (resolution.outcome !== "ambiguous") return;
    expect(resolution.candidates.every((c) => leafLabel(c) === "method-implementation")).toBe(true);
    expect(resolution.candidates.map((c) => c.identity.file).sort()).toEqual([
      "src/contract/Circle.ts",
      "src/contract/Square.ts",
    ]);
  });

  it("resolves a declaration-only interface method to its declaration", async () => {
    const resolution = await backend().findCallTarget(ALL_FILES, {
      file: "src/contract/Drawable.ts",
      segments: [{ name: "Drawable" }, { name: "render" }],
    });
    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.target.identity.file).toBe("src/contract/Drawable.ts");
    expect(leafLabel(resolution.target)).toBe("method-declaration");
  });

  it("resolves a single-implementation contract method to the concrete implementation", async () => {
    const resolution = await backend().findCallTarget(ALL_FILES, {
      file: "src/contract/Service.ts",
      segments: [{ name: "Service" }, { name: "run" }],
    });
    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.target.identity.file).toBe("src/contract/ConcreteService.ts");
    expect(resolution.target.identity.segments.map((s) => s.name)).toEqual([
      "ConcreteService",
      "run",
    ]);
    expect(leafLabel(resolution.target)).toBe("method-implementation");
  });

  it("reports an identity matching nothing as not-found", async () => {
    const resolution = await backend().findCallTarget(ALL_FILES, {
      file: "src/plain.ts",
      segments: [{ name: "missing" }],
    });
    expect(resolution.outcome).toBe("not-found");
  });
});
