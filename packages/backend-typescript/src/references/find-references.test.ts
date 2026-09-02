import { describe, expect, it } from "vitest";

import {
  InMemoryFileSystem,
  SymbolNotFoundError,
  type SymbolReference,
  type SymbolIdentity,
} from "@symnav/core";

import { ReferenceFinder } from "./find-references.js";
import { TypeScriptWorkspaceState } from "../typescript-backend/typescript-workspace-state.js";

async function refsIn(
  files: Record<string, string>,
  identity: SymbolIdentity,
): Promise<readonly SymbolReference[]> {
  const absoluteEntries = Object.fromEntries(
    Object.entries(files).map(([relative, source]) => [`/repo/${relative}`, source]),
  );
  const fs = new InMemoryFileSystem(absoluteEntries);
  const paths = Object.keys(files).map((relative) => ({
    relative,
    absolute: `/repo/${relative}`,
  }));
  return new ReferenceFinder({
    state: new TypeScriptWorkspaceState(fs),
    files: paths,
    identity,
  }).find();
}

function identityOf(file: string, ...names: string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}

function matchedText(reference: SymbolReference): string {
  return reference.previewSource.slice(reference.matchStart, reference.matchEnd);
}

describe("findReferences", () => {
  it("finds references in files other than the defining file", async () => {
    const result = await refsIn(
      {
        "src/billing/Invoice.ts": "export class Invoice {}\n",
        "src/app/a.ts": [
          'import { Invoice } from "../billing/Invoice.js";',
          "",
          "export const a = new Invoice();",
          "",
        ].join("\n"),
        "src/app/b.ts": [
          'import { Invoice } from "../billing/Invoice.js";',
          "",
          "export const b = new Invoice();",
          "",
        ].join("\n"),
      },
      identityOf("src/billing/Invoice.ts", "Invoice"),
    );
    const files = new Set(result.map((reference) => reference.file));
    expect(files).toContain("src/app/a.ts");
    expect(files).toContain("src/app/b.ts");
  });

  it("excludes the declaration itself, returning only true references", async () => {
    const result = await refsIn(
      {
        "src/Payment.ts": ["export interface Payment {", "  amount: number;", "}", ""].join("\n"),
        "src/CardPayment.ts": [
          'import { Payment } from "./Payment.js";',
          "",
          "export class CardPayment implements Payment {",
          "  amount = 0;",
          "}",
          "",
        ].join("\n"),
      },
      identityOf("src/Payment.ts", "Payment"),
    );
    expect(result).toHaveLength(2);
    expect(result.every((reference) => reference.file === "src/CardPayment.ts")).toBe(true);
    expect(result.every((reference) => matchedText(reference) === "Payment")).toBe(true);
  });

  it("excludes overload signature lines, returning call sites only", async () => {
    const result = await refsIn(
      {
        "src/math.ts": [
          "export function area(side: number): number;",
          "export function area(width: number, height: number): number;",
          "export function area(a: number, b?: number): number {",
          "  return a * (b ?? a);",
          "}",
          "",
        ].join("\n"),
        "src/use-math.ts": [
          'import { area } from "./math.js";',
          "",
          "export const x = area(2);",
          "",
        ].join("\n"),
      },
      identityOf("src/math.ts", "area"),
    );
    expect(result.every((reference) => reference.file === "src/use-math.ts")).toBe(true);
    expect(result.map((reference) => reference.line).sort()).toEqual([1, 3]);
  });

  it("classifies named, default, and type-only imports as import", async () => {
    const namedResult = await refsIn(
      {
        "src/lib/Named.ts": "export class Named {}\n",
        "src/app/named-importer.ts": [
          'import { Named } from "../lib/Named.js";',
          "",
          "export const n = new Named();",
          "",
        ].join("\n"),
        "src/app/type-importer.ts": [
          'import type { Named } from "../lib/Named.js";',
          "",
          "export type N = Named;",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/Named.ts", "Named"),
    );
    const importLines = namedResult.filter((reference) => reference.kind === "import");
    expect(importLines).toEqual([
      expect.objectContaining({ file: "src/app/named-importer.ts", line: 1 }),
      expect.objectContaining({ file: "src/app/type-importer.ts", line: 1 }),
    ]);

    const defaultResult = await refsIn(
      {
        "src/lib/Def.ts": "export default class Def {}\n",
        "src/app/default-importer.ts": [
          'import Def from "../lib/Def.js";',
          "",
          "export const d = new Def();",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/Def.ts", "Def"),
    );
    expect(defaultResult).toContainEqual(
      expect.objectContaining({ file: "src/app/default-importer.ts", line: 1, kind: "import" }),
    );
  });

  it("classifies export clauses and re-exports as export", async () => {
    const result = await refsIn(
      {
        "src/lib/Widget.ts": "export class Widget {}\n",
        "src/barrel-reexport.ts": 'export { Widget } from "./lib/Widget.js";\n',
        "src/barrel-local.ts": [
          'import { Widget } from "./lib/Widget.js";',
          "",
          "export { Widget };",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/Widget.ts", "Widget"),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ file: "src/barrel-reexport.ts", line: 1, kind: "export" }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ file: "src/barrel-local.ts", line: 3, kind: "export" }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ file: "src/barrel-local.ts", line: 1, kind: "import" }),
    );
  });

  it("classifies type positions as type", async () => {
    const result = await refsIn(
      {
        "src/lib/Shape.ts": "export class Shape {}\n",
        "src/app/shape-types.ts": [
          'import { Shape } from "../lib/Shape.js";',
          "",
          "export class Blob implements Shape {}",
          "export const shapes: Array<Shape> = [];",
          "export type ShapeCtor = typeof Shape;",
          "export function draw(shape: Shape): void {",
          "  void shape;",
          "}",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/Shape.ts", "Shape"),
    );
    const kindsByLine = new Map(
      result
        .filter((reference) => reference.file === "src/app/shape-types.ts")
        .map((reference) => [reference.line, reference.kind]),
    );
    expect(kindsByLine.get(3)).toBe("type");
    expect(kindsByLine.get(4)).toBe("type");
    expect(kindsByLine.get(5)).toBe("type");
    expect(kindsByLine.get(6)).toBe("type");
  });

  it("classifies value positions as usage", async () => {
    const result = await refsIn(
      {
        "src/lib/Engine.ts": ["export class Engine {", "  static start(): void {}", "}", ""].join(
          "\n",
        ),
        "src/app/engine-user.ts": [
          'import { Engine } from "../lib/Engine.js";',
          "",
          "export class Turbo extends Engine {}",
          "export const engine = new Engine();",
          "Engine.start();",
          "export const alias = Engine;",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/Engine.ts", "Engine"),
    );
    const kindsByLine = new Map(
      result
        .filter((reference) => reference.file === "src/app/engine-user.ts")
        .map((reference) => [reference.line, reference.kind]),
    );
    expect(kindsByLine.get(3)).toBe("usage");
    expect(kindsByLine.get(4)).toBe("usage");
    expect(kindsByLine.get(5)).toBe("usage");
    expect(kindsByLine.get(6)).toBe("usage");
  });

  it("classifies a call as usage", async () => {
    const result = await refsIn(
      {
        "src/lib/run.ts": "export function run(): void {}\n",
        "src/app/run-user.ts": ['import { run } from "../lib/run.js";', "", "run();", ""].join(
          "\n",
        ),
      },
      identityOf("src/lib/run.ts", "run"),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ file: "src/app/run-user.ts", line: 3, kind: "usage" }),
    );
  });

  it("finds references nested inside executable control-flow blocks", async () => {
    const result = await refsIn(
      {
        "src/lib/run.ts": "export function run(): void {}\n",
        "src/app/run-user.ts": [
          'import { run } from "../lib/run.js";',
          "",
          "export function main(items: readonly string[], enabled: boolean): void {",
          "  if (enabled) {",
          "    run();",
          "  }",
          "  for (const item of items) {",
          "    if (item) {",
          "      run();",
          "    }",
          "  }",
          "  while (enabled) {",
          "    run();",
          "    break;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/run.ts", "run"),
    );
    expect(result).toEqual([
      expect.objectContaining({ file: "src/app/run-user.ts", line: 1, kind: "import" }),
      expect.objectContaining({ file: "src/app/run-user.ts", line: 5, kind: "usage" }),
      expect.objectContaining({ file: "src/app/run-user.ts", line: 9, kind: "usage" }),
      expect.objectContaining({ file: "src/app/run-user.ts", line: 13, kind: "usage" }),
    ]);
  });

  it("follows a re-export chain back to the original symbol", async () => {
    const result = await refsIn(
      {
        "src/lib/Token.ts": "export class Token {}\n",
        "src/lib/index.ts": 'export { Token } from "./Token.js";\n',
        "src/app/token-user.ts": [
          'import { Token } from "../lib/index.js";',
          "",
          "export const t = new Token();",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/Token.ts", "Token"),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ file: "src/app/token-user.ts", line: 3, kind: "usage" }),
    );
  });

  it("returns the verbatim line and a span that slices to the symbol name", async () => {
    const result = await refsIn(
      {
        "src/lib/ping.ts": "export function ping(): void {}\n",
        "src/app/ping-user.ts": [
          'import { ping } from "../lib/ping.js";',
          "",
          "export function main(): void {",
          "  ping();",
          "}",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/ping.ts", "ping"),
    );
    const callSite = result.find(
      (reference) => reference.file === "src/app/ping-user.ts" && reference.line === 4,
    );
    expect(callSite?.previewSource).toBe("  ping();");
    expect(callSite && matchedText(callSite)).toBe("ping");
  });

  it("returns two references with distinct spans for one line", async () => {
    const result = await refsIn(
      {
        "src/lib/flag.ts": "export const flag = true;\n",
        "src/app/flag-user.ts": [
          'import { flag } from "../lib/flag.js";',
          "",
          "export const both = [flag, flag];",
          "",
        ].join("\n"),
      },
      identityOf("src/lib/flag.ts", "flag"),
    );
    const onLine = result.filter(
      (reference) => reference.file === "src/app/flag-user.ts" && reference.line === 3,
    );
    expect(onLine).toHaveLength(2);
    expect(onLine[0]!.matchStart).not.toBe(onLine[1]!.matchStart);
    expect(onLine.every((reference) => matchedText(reference) === "flag")).toBe(true);
  });

  it("returns an empty list for an unreferenced symbol", async () => {
    const result = await refsIn(
      { "src/lone.ts": "class Lone {}\n" },
      identityOf("src/lone.ts", "Lone"),
    );
    expect(result).toEqual([]);
  });

  it("throws SymbolNotFoundError when the identity matches nothing", async () => {
    await expect(
      refsIn({ "src/lone.ts": "class Lone {}\n" }, identityOf("src/lone.ts", "Ghost")),
    ).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it("finds references to a method, not its class", async () => {
    const result = await refsIn(
      {
        "src/billing/Invoice.ts": [
          "export class Invoice {",
          "  total(): number {",
          "    return 42;",
          "  }",
          "}",
          "",
        ].join("\n"),
        "src/app/invoice-user.ts": [
          'import { Invoice } from "../billing/Invoice.js";',
          "",
          "export const invoice = new Invoice();",
          "invoice.total();",
          "",
        ].join("\n"),
      },
      identityOf("src/billing/Invoice.ts", "Invoice", "total"),
    );
    expect(result).toEqual([
      expect.objectContaining({ file: "src/app/invoice-user.ts", line: 4, kind: "usage" }),
    ]);
    expect(matchedText(result[0]!)).toBe("total");
  });
});
