import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type ResolvedPath } from "@symnav/core";

import { resolveSymbols } from "./resolve-symbols.js";

const FIXTURE: Record<string, string> = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/src/payments/PaymentProcessor.ts": [
    "export class PaymentProcessor {",
    "  static async charge(orderId: string): Promise<string> {",
    "    return `paid:${orderId}`;",
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
  "/repo/src/payments/types.ts": [
    'export type PaymentStatus = "pending" | "paid" | "failed";',
    "",
    "export interface Payment {",
    "  readonly id: string;",
    "}",
    "",
  ].join("\n"),
  "/repo/src/checkout/CheckoutService.ts": [
    "export const MAX_PAYMENT_RETRIES = 3;",
    "",
    "export interface Payment {",
    "  readonly orderId: string;",
    "}",
    "",
    "export class CheckoutService {",
    "  async processPayment(orderId: string): Promise<string> {",
    "    return `processed:${orderId}`;",
    "  }",
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
  "src/checkout/CheckoutService.ts",
  "src/payments/PaymentProcessor.ts",
  "src/payments/PaymentProvider.ts",
  "src/payments/types.ts",
]);

function names(
  decls: readonly { identity: { segments: readonly { name: string }[] } }[],
): string[] {
  return decls.map((d) => d.identity.segments.map((s) => s.name).join("::"));
}

describe("resolveSymbols (exact)", () => {
  it("returns the one symbol that matches by exact name", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "PaymentProcessor",
      options: { fuzzy: false },
    });
    expect(names(result)).toEqual(["PaymentProcessor"]);
  });

  it("is case-sensitive: lowercased query returns nothing", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "paymentprocessor",
      options: { fuzzy: false },
    });
    expect(result).toEqual([]);
  });

  it("finds nested symbols (a method on a class)", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "charge",
      options: { fuzzy: false },
    });
    expect(names(result).sort()).toEqual(
      ["PaymentProcessor::charge", "PaymentProvider::charge"].sort(),
    );
  });

  it("surfaces every occurrence of a name across files", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "Payment",
      options: { fuzzy: false },
    });
    expect(result.map((d) => d.identity.file).sort()).toEqual(
      ["src/checkout/CheckoutService.ts", "src/payments/types.ts"].sort(),
    );
    expect(names(result)).toEqual(["Payment", "Payment"]);
  });

  it("returns empty for a no-match query", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "NoSuchSymbol",
      options: { fuzzy: false },
    });
    expect(result).toEqual([]);
  });
});

describe("resolveSymbols (fuzzy)", () => {
  it("matches case-insensitively as a subsequence", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "payproc",
      options: { fuzzy: true },
    });
    expect(names(result)).toContain("PaymentProcessor");
  });

  it("ranks consecutive/boundary matches above scattered matches", async () => {
    const result = await resolveSymbols({
      fs: fsWithFixture(),
      files: ALL_FILES,
      query: "payment",
      options: { fuzzy: true },
    });
    const all = names(result);
    expect(all.length).toBeGreaterThan(1);
    const paymentIndex = all.indexOf("Payment");
    const retriesIndex = all.indexOf("MAX_PAYMENT_RETRIES");
    expect(paymentIndex).toBeGreaterThanOrEqual(0);
    expect(retriesIndex).toBeGreaterThanOrEqual(0);
    expect(paymentIndex).toBeLessThan(retriesIndex);
  });
});
