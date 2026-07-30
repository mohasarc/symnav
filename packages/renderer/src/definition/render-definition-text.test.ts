import { describe, expect, it } from "vitest";

import type {
  DefinitionResult,
  Signature,
  SymbolOverviewNode,
  SymbolPathSegment,
} from "@symnav/core";

import { renderDefinitionText } from "./render-definition-text.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly nativeLabel: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly header: readonly string[];
}

function decl(input: DeclInput): SymbolOverviewNode {
  const sig: Signature = { startLine: input.startLine, lines: input.header };
  return {
    type: "symbol",
    identity: { file: input.file, segments: input.segments },
    kind: { role: "callable", nativeLabel: input.nativeLabel },
    range: { startLine: input.startLine, endLine: input.endLine },
    header: sig,
    children: [],
  };
}

describe("renderDefinitionText", () => {
  it("renders the overloaded Router::post example with bracket tags", () => {
    const result: DefinitionResult = {
      identity: { file: "src/http/Router.ts", segments: [{ name: "Router" }, { name: "post" }] },
      symbols: [
        decl({
          file: "src/http/Router.ts",
          segments: [{ name: "Router" }, { name: "post", disambiguator: 1 }],
          nativeLabel: "method-overload-signature",
          startLine: 4,
          endLine: 4,
          header: ["post(path: string, handler: Handler): void"],
        }),
        decl({
          file: "src/http/Router.ts",
          segments: [{ name: "Router" }, { name: "post", disambiguator: 2 }],
          nativeLabel: "method-overload-signature",
          startLine: 5,
          endLine: 5,
          header: ["post(path: RegExp, handler: Handler): void"],
        }),
        decl({
          file: "src/http/Router.ts",
          segments: [{ name: "Router" }, { name: "post", disambiguator: 3 }],
          nativeLabel: "method-implementation",
          startLine: 6,
          endLine: 9,
          header: ["post(path: string | RegExp, handler: Handler): void"],
        }),
      ],
    };
    expect(renderDefinitionText(result)).toBe(
      [
        "Definition: Router::post",
        "",
        "src/http/Router.ts",
        "├── 4: Router::post#1  [overload]",
        "│   post(path: string, handler: Handler): void",
        "├── 5: Router::post#2  [overload]",
        "│   post(path: RegExp, handler: Handler): void",
        "└── 6-9: Router::post#3  [implementation]",
        "    post(path: string | RegExp, handler: Handler): void",
        "",
      ].join("\n"),
    );
  });

  it("groups symbols by file across multiple implementations of a contract", () => {
    const result: DefinitionResult = {
      identity: {
        file: "src/payments/PaymentProvider.ts",
        segments: [{ name: "PaymentProvider" }, { name: "charge" }],
      },
      symbols: [
        decl({
          file: "src/payments/PaymentProvider.ts",
          segments: [{ name: "PaymentProvider" }, { name: "charge" }],
          nativeLabel: "method-declaration",
          startLine: 2,
          endLine: 2,
          header: ["charge(orderId: string): Promise<string>"],
        }),
        decl({
          file: "src/payments/StripeProvider.ts",
          segments: [{ name: "StripeProvider" }, { name: "charge" }],
          nativeLabel: "method-implementation",
          startLine: 4,
          endLine: 6,
          header: ["async charge(orderId: string): Promise<string>"],
        }),
        decl({
          file: "src/payments/PaypalProvider.ts",
          segments: [{ name: "PaypalProvider" }, { name: "charge" }],
          nativeLabel: "method-implementation",
          startLine: 4,
          endLine: 6,
          header: ["async charge(orderId: string): Promise<string>"],
        }),
      ],
    };
    expect(renderDefinitionText(result)).toBe(
      [
        "Definition: PaymentProvider::charge",
        "",
        "src/payments/PaymentProvider.ts",
        "└── 2: PaymentProvider::charge  [declaration]",
        "    charge(orderId: string): Promise<string>",
        "",
        "src/payments/StripeProvider.ts",
        "└── 4-6: StripeProvider::charge  [implementation]",
        "    async charge(orderId: string): Promise<string>",
        "",
        "src/payments/PaypalProvider.ts",
        "└── 4-6: PaypalProvider::charge  [implementation]",
        "    async charge(orderId: string): Promise<string>",
        "",
      ].join("\n"),
    );
  });

  it("renders an empty-match result with a no-matches notice", () => {
    const result: DefinitionResult = {
      identity: {
        file: "src/payments/PaymentProvider.ts",
        segments: [{ name: "PaymentProvider" }, { name: "ghost" }],
      },
      symbols: [],
    };
    expect(renderDefinitionText(result)).toBe(
      ["Definition: PaymentProvider::ghost", "", "(no matching definitions)", ""].join("\n"),
    );
  });

  it("omits the bracket tag when the label has no mapping", () => {
    const result: DefinitionResult = {
      identity: { file: "src/util/constants.ts", segments: [{ name: "PI" }] },
      symbols: [
        decl({
          file: "src/util/constants.ts",
          segments: [{ name: "PI" }],
          nativeLabel: "variable",
          startLine: 1,
          endLine: 1,
          header: ["const PI = 3.14"],
        }),
      ],
    };
    expect(renderDefinitionText(result)).toBe(
      ["Definition: PI", "", "src/util/constants.ts", "└── 1: PI", "    const PI = 3.14", ""].join(
        "\n",
      ),
    );
  });
});
