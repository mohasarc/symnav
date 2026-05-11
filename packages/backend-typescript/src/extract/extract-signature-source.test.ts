import { describe, expect, it } from "vitest";
import { Node, type SourceFile, type Statement } from "ts-morph";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractSignatureSource } from "./extract-signature-source.js";

function firstStatement(file: SourceFile): Statement {
  const stmt = file.getStatements()[0];
  if (!stmt) throw new Error("expected at least one statement");
  return stmt;
}

describe("extractSignatureSource", () => {
  describe("function declarations", () => {
    it("plain function: text up to body brace, no trailing semicolon", () => {
      const file = parseTypeScriptSource(
        "export function greet(name: string): string { return name; }",
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "export function greet(name: string): string",
      );
    });

    it("async function: keeps async keyword", () => {
      const file = parseTypeScriptSource(
        "export async function load(): Promise<void> { await Promise.resolve(); }",
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "export async function load(): Promise<void>",
      );
    });

    it("generator function: keeps asterisk", () => {
      const file = parseTypeScriptSource("function* counter(): Generator<number> { yield 1; }");
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "function* counter(): Generator<number>",
      );
    });

    it("generic function: keeps type parameters", () => {
      const file = parseTypeScriptSource(
        "function identity<T extends object>(value: T): T { return value; }",
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "function identity<T extends object>(value: T): T",
      );
    });

    it("overload signature without body retains its trailing semicolon-stripped form", () => {
      const file = parseTypeScriptSource(
        "export function pick(a: string): string;\nexport function pick(a: number): number;\nexport function pick(a: string | number): string | number { return a; }",
      );
      const overload = file.getStatements()[0];
      if (!overload) throw new Error("expected first overload");
      expect(extractSignatureSource(overload)).toBe("export function pick(a: string): string");
    });
  });

  describe("class / interface / enum / namespace", () => {
    it("class declaration ends at opening brace", () => {
      const file = parseTypeScriptSource(
        "export class CheckoutService extends Base implements Iface { m() {} }",
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "export class CheckoutService extends Base implements Iface",
      );
    });

    it("interface declaration ends at opening brace", () => {
      const file = parseTypeScriptSource("export interface Cart<T> extends Base { items: T[] }");
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "export interface Cart<T> extends Base",
      );
    });

    it("enum declaration ends at opening brace", () => {
      const file = parseTypeScriptSource("export enum Mode { On, Off }");
      expect(extractSignatureSource(firstStatement(file))).toBe("export enum Mode");
    });

    it("namespace declaration ends at opening brace", () => {
      const file = parseTypeScriptSource("export namespace Outer { export const x = 1; }");
      expect(extractSignatureSource(firstStatement(file))).toBe("export namespace Outer");
    });
  });

  describe("type alias", () => {
    it("runs to the terminating semicolon, returned in full", () => {
      const file = parseTypeScriptSource(
        "export type LongUnion = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k';",
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "export type LongUnion = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k'",
      );
    });
  });

  describe("variable statements", () => {
    it("annotated variable: const name plus annotation, no initializer", () => {
      const file = parseTypeScriptSource("const total: number = computeTotal();");
      expect(extractSignatureSource(firstStatement(file))).toBe("const total: number");
    });

    it("unannotated variable: const name plus initializer in full", () => {
      const file = parseTypeScriptSource(
        "const items = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];",
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        "const items = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']",
      );
    });

    it("let variable uses the let keyword", () => {
      const file = parseTypeScriptSource("let counter: number = 0;");
      expect(extractSignatureSource(firstStatement(file))).toBe("let counter: number");
    });

    it("var variable uses the var keyword", () => {
      const file = parseTypeScriptSource("var legacy = 1;");
      expect(extractSignatureSource(firstStatement(file))).toBe("var legacy = 1");
    });
  });

  describe("default export", () => {
    it("returns the expression text", () => {
      const file = parseTypeScriptSource("export default { handler: 'main' };");
      const stmt = firstStatement(file);
      if (!Node.isExportAssignment(stmt)) throw new Error("expected export assignment");
      expect(extractSignatureSource(stmt)).toBe("{ handler: 'main' }");
    });
  });
});
