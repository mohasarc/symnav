import { describe, expect, it } from "vitest";

import type {
  DefinitionResult,
  DefinitionSymbol,
  Header,
  SymbolOverviewNode,
  SymbolPathSegment,
  SymbolRole,
} from "@symnav/core";

import { DefinitionTextRenderer, renderDefinitionText } from "./render-definition-text.js";

interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly nativeLabel: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly header: readonly string[];
}

function decl(input: DeclInput): SymbolOverviewNode {
  const sig: Header = { startLine: input.startLine, lines: input.header };
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

  it("prints numbered source lines in place of the header when source is attached", () => {
    const result: DefinitionResult = {
      identity: { file: "src/http/Router.ts", segments: [{ name: "Router" }, { name: "post" }] },
      symbols: [
        {
          ...decl({
            file: "src/http/Router.ts",
            segments: [{ name: "Router" }, { name: "post", disambiguator: 1 }],
            nativeLabel: "method-overload-signature",
            startLine: 8,
            endLine: 8,
            header: ["post(path: string, handler: Handler): void"],
          }),
          source: { startLine: 8, lines: ["  post(path: string, handler: Handler): void;"] },
        },
        {
          ...decl({
            file: "src/http/Router.ts",
            segments: [{ name: "Router" }, { name: "post", disambiguator: 2 }],
            nativeLabel: "method-implementation",
            startLine: 9,
            endLine: 12,
            header: ["post(path: string | RegExp, handler: Handler): void"],
          }),
          source: {
            startLine: 9,
            lines: [
              "  post(path: string | RegExp, handler: Handler): void {",
              "    void path;",
              "    void handler;",
              "  }",
            ],
          },
        },
      ],
    };
    expect(renderDefinitionText(result)).toBe(
      [
        "Definition: Router::post",
        "",
        "src/http/Router.ts",
        "├── 8: Router::post#1  [overload]",
        "│   8   post(path: string, handler: Handler): void;",
        "└── 9-12: Router::post#2  [implementation]",
        "     9   post(path: string | RegExp, handler: Handler): void {",
        "    10     void path;",
        "    11     void handler;",
        "    12   }",
        "",
      ].join("\n"),
    );
  });
});

class SourcedDefinition {
  static of(input: {
    readonly file: string;
    readonly names: readonly string[];
    readonly role: SymbolRole;
    readonly nativeLabel: string;
    readonly startLine: number;
    readonly lines: readonly string[];
  }): DefinitionSymbol {
    return {
      type: "symbol",
      identity: { file: input.file, segments: input.names.map((name) => ({ name })) },
      kind: { role: input.role, nativeLabel: input.nativeLabel },
      range: { startLine: input.startLine, endLine: input.startLine + input.lines.length - 1 },
      header: { startLine: input.startLine, lines: [input.lines[0]?.trim() ?? ""] },
      children: [],
      source: { startLine: input.startLine, lines: input.lines },
    };
  }

  static runMethod(file: string, className: string, startLine: number): DefinitionSymbol {
    const steps = Array.from({ length: 6 }, (_, index) => `    step${className}${index}();`);
    return SourcedDefinition.of({
      file,
      names: [className, "run"],
      role: "callable",
      nativeLabel: "method-implementation",
      startLine,
      lines: ["  run(): number {", ...steps, "    return 0;", "  }"],
    });
  }
}

describe("DefinitionTextRenderer source budget", () => {
  it("prints later definitions as signatures and names them once the budget is spent", () => {
    const result: DefinitionResult = {
      identity: { file: "src/a.ts", segments: [{ name: "Runner" }, { name: "run" }] },
      symbols: [
        SourcedDefinition.runMethod("src/a.ts", "A", 2),
        SourcedDefinition.runMethod("src/b.ts", "B", 2),
        SourcedDefinition.runMethod("src/b.ts", "C", 12),
      ],
    };

    const text = DefinitionTextRenderer.render(result, 600);

    expect(text).toBe(
      [
        "Definition: Runner::run",
        "",
        "src/a.ts",
        "└── 2-10: A::run  [implementation]",
        "     2   run(): number {",
        "     3     stepA0();",
        "     4     stepA1();",
        "     5     stepA2();",
        "     6     stepA3();",
        "     7     stepA4();",
        "     8     stepA5();",
        "     9     return 0;",
        "    10   }",
        "",
        "src/b.ts",
        "├── 2-10: B::run  [implementation]",
        "│   run(): number {",
        "└── 12-20: C::run  [implementation]",
        "    run(): number {",
        "… cut to fit 600 chars",
        "… source not shown: src/b.ts::B::run",
        "… source not shown: src/b.ts::C::run",
        "… more: def --source '<id>' for one definition",
        "",
      ].join("\n"),
    );
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("prints every source when the whole output fits", () => {
    const result: DefinitionResult = {
      identity: { file: "src/a.ts", segments: [{ name: "Runner" }, { name: "run" }] },
      symbols: [
        SourcedDefinition.runMethod("src/a.ts", "A", 2),
        SourcedDefinition.runMethod("src/b.ts", "B", 2),
      ],
    };

    const text = DefinitionTextRenderer.render(result, 600);

    expect(text).toContain("     8     stepA5();");
    expect(text).toContain("     8     stepB5();");
    expect(text).not.toContain("… cut to fit");
  });
});
