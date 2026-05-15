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

  describe("default export", () => {
    it("returns the expression text", () => {
      const file = parseTypeScriptSource("export default { handler: 'main' };");
      const stmt = firstStatement(file);
      if (!Node.isExportAssignment(stmt)) throw new Error("expected export assignment");
      expect(extractSignatureSource(stmt)).toBe("{ handler: 'main' }");
    });
  });

  describe("multi-line declarations", () => {
    it("leaves a top-level multi-line signature flush", () => {
      const file = parseTypeScriptSource(
        ["function configure(", "  host: string,", "): void {", "  void host;", "}"].join("\n"),
      );
      expect(extractSignatureSource(firstStatement(file))).toBe(
        ["function configure(", "  host: string,", "): void"].join("\n"),
      );
    });

    it("strips ambient indentation from continuation lines of a nested declaration", () => {
      const file = parseTypeScriptSource(
        [
          "class Server {",
          "  start(",
          "    host: string,",
          "  ): void {",
          "    void host;",
          "  }",
          "}",
        ].join("\n"),
      );
      const cls = firstStatement(file);
      if (!Node.isClassDeclaration(cls)) throw new Error("expected class");
      const member = cls.getMembers()[0];
      if (!member) throw new Error("expected member");
      expect(extractSignatureSource(member)).toBe(
        ["start(", "  host: string,", "): void"].join("\n"),
      );
    });
  });
});
