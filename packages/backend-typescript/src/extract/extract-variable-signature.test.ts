import { describe, expect, it } from "vitest";
import { Node, type VariableDeclaration, type VariableStatement } from "ts-morph";

import { parseTypeScriptSource } from "../../test/helpers/parse-typescript-source.js";
import { extractVariableSignature } from "./extract-variable-signature.js";

function firstVariable(source: string): {
  readonly statement: VariableStatement;
  readonly declaration: VariableDeclaration;
} {
  const file = parseTypeScriptSource(source);
  const statement = file.getStatements()[0];
  if (!Node.isVariableStatement(statement)) throw new Error("expected variable statement");
  const declaration = statement.getDeclarationList().getDeclarations()[0];
  if (!declaration) throw new Error("expected variable declaration");
  return { statement, declaration };
}

describe("extractVariableSignature", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly expected: string;
  }> = [
    {
      name: "arrow function initializer",
      source: "export const helper = (value: string): string => { return value.trim(); };",
      expected: "export const helper = (value: string): string => …",
    },
    {
      name: "function expression initializer",
      source: "const helper = function (value: string): string { return value.trim(); };",
      expected: "const helper = function (value: string): string …",
    },
    {
      name: "zero-argument call initializer",
      source: "const registry = createRegistry();",
      expected: "const registry = createRegistry()",
    },
    {
      name: "zero-argument member call initializer",
      source: "const registry = factories.createRegistry();",
      expected: "const registry = factories.createRegistry()",
    },
    {
      name: "zero-argument call on nested factory call initializer",
      source: "const fn = factory({ retry: true, attempts: MAX_RETRY_ATTEMPTS })();",
      expected: "const fn = factory(…)()",
    },
    {
      name: "schema builder call initializer",
      source: "const schema = z.object({ name: z.string(), count: z.number() });",
      expected: "const schema = z.object(…)",
    },
    {
      name: "chained schema builder call initializer",
      source:
        "const schema = z.object({ name: z.string(), count: z.number() }).extend({ id: z.string() });",
      expected: "const schema = z.object(…).extend(…)",
    },
    {
      name: "parenthesized chained schema builder call initializer",
      source:
        "const schema = (z.object({ name: z.string(), count: z.number() })).extend({ id: z.string() });",
      expected: "const schema = z.object(…).extend(…)",
    },
    {
      name: "asserted chained schema builder call initializer",
      source:
        "const schema = (z.object({ name: z.string(), count: z.number() }) as Schema).extend({ id: z.string() });",
      expected: "const schema = z.object(…).extend(…)",
    },
    {
      name: "nested factory call initializer",
      source: "const fn = factory({ retry: true, attempts: MAX_RETRY_ATTEMPTS })({ id: 1 });",
      expected: "const fn = factory(…)(…)",
    },
    {
      name: "tagged template initializer",
      source: "const query = gql`query { user { id name email createdAt } }`;",
      expected: "const query = gql`…`",
    },
    {
      name: "member-tagged template initializer",
      source: "const Button = styled.div`display: flex; color: ${theme.primary};`;",
      expected: "const Button = styled.div`…`",
    },
    {
      name: "awaited call initializer",
      source: "const data = await fetchData({ retry: true, attempts: MAX_RETRY_ATTEMPTS });",
      expected: "const data = await fetchData(…)",
    },
    {
      name: "new expression initializer",
      source: "const client = new Client({ retry: true, attempts: MAX_RETRY_ATTEMPTS });",
      expected: "const client = new Client(…)",
    },
    {
      name: "anonymous class new expression initializer",
      source: "const service = new class { run() { return { retry: true }; } }();",
      expected: "const service = new class …()",
    },
    {
      name: "anonymous class new expression initializer with argument",
      source: "const service = new class { run() { return { retry: true }; } }({ id: 1 });",
      expected: "const service = new class …(…)",
    },
    {
      name: "void call initializer",
      source: "const data = void fetchData({ retry: true, attempts: MAX_RETRY_ATTEMPTS });",
      expected: "const data = void fetchData(…)",
    },
    {
      name: "conditional initializer collapses only long branches",
      source:
        "const config = enabled ? { retry: true, attempts: MAX_RETRY_ATTEMPTS } : { retry: false };",
      expected: "const config = enabled ? { … } : { retry: false }",
    },
    {
      name: "array literal initializer",
      source: "const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];",
      expected: "const values = […]",
    },
    {
      name: "array literal as const initializer",
      source: "const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;",
      expected: "const values = […]",
    },
    {
      name: "object literal satisfies initializer",
      source: "const config = { retry: true, attempts: MAX_RETRY_ATTEMPTS } satisfies Options;",
      expected: "const config = { … }",
    },
    {
      name: "object literal as type initializer",
      source: "const casted = { retry: true, attempts: MAX_RETRY_ATTEMPTS } as Options;",
      expected: "const casted = { … }",
    },
    {
      name: "object literal type assertion initializer",
      source: "const casted = <Options>{ retry: true, attempts: MAX_RETRY_ATTEMPTS };",
      expected: "const casted = { … }",
    },
    {
      name: "object literal non-null assertion initializer",
      source: "const config = ({ retry: true, attempts: MAX_RETRY_ATTEMPTS })!;",
      expected: "const config = { … }",
    },
    {
      name: "short object literal initializer kept verbatim",
      source: "const config = { retry: true };",
      expected: "const config = { retry: true }",
    },
    {
      name: "short array literal initializer kept verbatim",
      source: "const values = [1, 2, 3, 4];",
      expected: "const values = [1, 2, 3, 4]",
    },
    {
      name: "short call initializer kept verbatim",
      source: "const data = fetchData({ retry: true });",
      expected: "const data = fetchData({ retry: true })",
    },
    {
      name: "short chain target kept verbatim inside long chain",
      source:
        "const schema = z.object({ id: z.string() }).extend({ id: z.string(), name: z.string() });",
      expected: "const schema = z.object({ id: z.string() }).extend(…)",
    },
    {
      name: "long string literal initializer collapses",
      source: 'const banner = "this banner string is far too long to keep in a header";',
      expected: "const banner = …",
    },
    {
      name: "multi-line short object literal initializer collapses",
      source: "const config = {\n  retry: true,\n};",
      expected: "const config = { … }",
    },
    {
      name: "literal initializer",
      source: "let count = 0;",
      expected: "let count = 0",
    },
    {
      name: "ambient declaration",
      source: "declare const y: T;",
      expected: "declare const y: T",
    },
  ];

  it.each(cases)("$name", ({ source, expected }) => {
    const { statement, declaration } = firstVariable(source);
    expect(extractVariableSignature({ statement, declaration })).toBe(expected);
  });
});
