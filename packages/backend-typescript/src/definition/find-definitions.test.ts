import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type ResolvedPath, type SymbolOverviewNode } from "@symnav/core";

import { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";
import { findDefinitions } from "./find-definitions.js";

const FIXTURE: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/http/Router.ts": [
    "export type Handler = (req: string) => string;",
    "",
    "export class Router {",
    "  post(path: string, handler: Handler): void;",
    "  post(path: RegExp, handler: Handler): void;",
    "  post(path: string | RegExp, handler: Handler): void {",
    "    void path;",
    "    void handler;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/payments/PaymentProvider.ts": [
    "export interface PaymentProvider {",
    "  charge(orderId: string): Promise<string>;",
    "}",
    "",
  ].join("\n"),
  "/repo/src/payments/StripeProvider.ts": [
    'import type { PaymentProvider } from "./PaymentProvider.js";',
    "",
    "export class StripeProvider implements PaymentProvider {",
    "  async charge(orderId: string): Promise<string> {",
    "    return `stripe:${orderId}`;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/payments/PaypalProvider.ts": [
    'import type { PaymentProvider } from "./PaymentProvider.js";',
    "",
    "export class PaypalProvider implements PaymentProvider {",
    "  async charge(orderId: string): Promise<string> {",
    "    return `paypal:${orderId}`;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/shapes/Shape.ts": [
    "export abstract class Shape {",
    "  abstract area(): number;",
    "}",
    "",
    "export class Circle extends Shape {",
    "  constructor(private readonly radius: number) {",
    "    super();",
    "  }",
    "  area(): number {",
    "    return Math.PI * this.radius * this.radius;",
    "  }",
    "}",
    "",
    "export class Square extends Shape {",
    "  constructor(private readonly side: number) {",
    "    super();",
    "  }",
    "  area(): number {",
    "    return this.side * this.side;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/control-flow/LocalDeclarations.ts": [
    "export function outer(flag: boolean, items: readonly string[]): void {",
    "  if (flag) {",
    "    function insideIf(): void {}",
    "    insideIf();",
    "  }",
    "  for (const item of items) {",
    "    const insideLoop = item;",
    "    void insideLoop;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "/repo/src/util/constants.ts": [
    "export const MAX_RETRIES = 3;",
    "",
    "export class Outer {",
    "  static inner = 1;",
    "}",
    "",
  ].join("\n"),
};

function pathsFor(relativePaths: readonly string[]): readonly ResolvedPath[] {
  return relativePaths.map((relative) => ({ relative, absolute: `/repo/${relative}` }));
}

function fsWithFixture() {
  return new InMemoryFileSystem(FIXTURE);
}

const ALL_FILES = pathsFor([
  "src/control-flow/LocalDeclarations.ts",
  "src/http/Router.ts",
  "src/payments/PaymentProvider.ts",
  "src/payments/PaypalProvider.ts",
  "src/payments/StripeProvider.ts",
  "src/shapes/Shape.ts",
  "src/util/constants.ts",
]);

function labelsAndFiles(
  decls: readonly SymbolOverviewNode[],
): readonly { label: string; file: string; name: string; disambiguator: number | undefined }[] {
  return decls.map((d) => {
    const leaf = d.identity.segments[d.identity.segments.length - 1]!;
    return {
      label: d.kind.nativeLabel,
      file: d.identity.file,
      name: leaf.name,
      disambiguator: leaf.disambiguator,
    };
  });
}

describe("findDefinitions", () => {
  it("returns a single match for a unique top-level value", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: { file: "src/util/constants.ts", segments: [{ name: "MAX_RETRIES" }] },
    });
    expect(labelsAndFiles(result)).toEqual([
      {
        label: "variable",
        file: "src/util/constants.ts",
        name: "MAX_RETRIES",
        disambiguator: undefined,
      },
    ]);
  });

  it("returns all overloads + implementation when the leaf has no disambiguator", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: { file: "src/http/Router.ts", segments: [{ name: "Router" }, { name: "post" }] },
    });
    const summary = labelsAndFiles(result);
    expect(summary).toHaveLength(3);
    expect(summary.map((s) => s.label).sort()).toEqual([
      "method-implementation",
      "method-overload-signature",
      "method-overload-signature",
    ]);
    expect(summary.every((s) => s.file === "src/http/Router.ts")).toBe(true);
    expect(summary.every((s) => s.name === "post")).toBe(true);
  });

  it("returns exactly one symbol when the leaf disambiguator is supplied", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: {
        file: "src/http/Router.ts",
        segments: [{ name: "Router" }, { name: "post", disambiguator: 1 }],
      },
    });
    expect(labelsAndFiles(result)).toEqual([
      {
        label: "method-overload-signature",
        file: "src/http/Router.ts",
        name: "post",
        disambiguator: 1,
      },
    ]);
  });

  it("returns the interface declaration plus every implementation across files", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: {
        file: "src/payments/PaymentProvider.ts",
        segments: [{ name: "PaymentProvider" }, { name: "charge" }],
      },
    });
    const summary = labelsAndFiles(result);
    expect(summary).toHaveLength(3);
    const files = summary.map((s) => s.file).sort();
    expect(files).toEqual(
      [
        "src/payments/PaymentProvider.ts",
        "src/payments/PaypalProvider.ts",
        "src/payments/StripeProvider.ts",
      ].sort(),
    );
    const declaration = summary.find((s) => s.file === "src/payments/PaymentProvider.ts");
    expect(declaration?.label).toBe("method-declaration");
    const stripe = summary.find((s) => s.file === "src/payments/StripeProvider.ts");
    expect(stripe?.label).toBe("method-implementation");
    const paypal = summary.find((s) => s.file === "src/payments/PaypalProvider.ts");
    expect(paypal?.label).toBe("method-implementation");
  });

  it("returns the abstract method plus every concrete override across subclasses", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: {
        file: "src/shapes/Shape.ts",
        segments: [{ name: "Shape" }, { name: "area" }],
      },
    });
    const summary = labelsAndFiles(result);
    expect(summary).toHaveLength(3);
    const abstractDecl = summary.find((s) => s.label === "method-declaration");
    expect(abstractDecl).toBeDefined();
    const impls = summary.filter((s) => s.label === "method-implementation");
    expect(impls.map((i) => i.name).sort()).toEqual(["area", "area"]);
  });

  it("returns no symbols when the path matches no symbol in the file", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: {
        file: "src/util/constants.ts",
        segments: [{ name: "Outer" }, { name: "ghost" }],
      },
    });
    expect(result).toEqual([]);
  });

  it("returns definitions for declarations nested inside executable control-flow blocks", async () => {
    const result = await findDefinitions({
      index: new WorkspaceDeclarationIndex(fsWithFixture()),
      files: ALL_FILES,
      identity: {
        file: "src/control-flow/LocalDeclarations.ts",
        segments: [{ name: "outer" }, { name: "insideLoop" }],
      },
    });
    expect(labelsAndFiles(result)).toEqual([
      {
        label: "variable",
        file: "src/control-flow/LocalDeclarations.ts",
        name: "insideLoop",
        disambiguator: undefined,
      },
    ]);
    expect(result[0]?.identity).toEqual({
      file: "src/control-flow/LocalDeclarations.ts",
      segments: [{ name: "outer" }, { name: "insideLoop" }],
    });
  });
});
