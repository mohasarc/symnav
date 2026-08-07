import { describe, expect, it } from "vitest";

import { runResolve, snapshot } from "./run-resolve.js";
import type { JsonSymbol } from "../json-identity.js";

interface JsonResolveResult {
  symbols: readonly JsonSymbol[];
}

describe("symnav resolve e2e (exact)", () => {
  it("renders exact PaymentProcessor", async () => {
    const r = runResolve(["resolve", "PaymentProcessor"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("exact-payment-processor.expected.txt"));
    expect(r.stdout).not.toContain("PayProcessor");
  });

  it("does not case-normalize or fuzzy-match exact queries", async () => {
    const r = runResolve(["resolve", "paymentprocessor"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(
      snapshot("exact-payment-processor-lowercase.expected.txt"),
    );
  });

  it.skip("names the broader matching modes on an empty exact result (ends on (none) today)", () => {
    const r = runResolve(["resolve", "paymentprocessor"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "No exact match; try --fuzzy for approximate names, or --regex for a pattern.",
    );
  });

  it("renders no-match with empty sections under headers", async () => {
    const r = runResolve(["resolve", "NoSuchSymbol"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("no-match.expected.txt"));
  });

  it("omits symbols from ignored files", () => {
    const r = runResolve(["resolve", "PaymentLeak"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("ignored-payments.ts");
    expect(r.stdout).not.toContain("class PaymentLeak");
  });

  it("finds declarations nested inside executable control-flow blocks", () => {
    const r = runResolve(["resolve", "insideIf"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/control-flow/LocalDeclarations.ts");
    expect(r.stdout).toContain("3: outer::insideIf");
    expect(r.stdout).toContain("function insideIf(): void");
    expect(r.stdout).not.toContain("if::insideIf");
  });

  it("finds declarations nested inside folds by full canonical id", () => {
    const r = runResolve(["resolve", "src/control-flow/LocalDeclarations.ts::outer::insideIf"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/control-flow/LocalDeclarations.ts");
    expect(r.stdout).toContain("3: outer::insideIf");
    expect(r.stdout).not.toContain("if::insideIf");
    expect(r.stdout).not.toContain("Symbols\n(none)");
  });

  it("emits declaration-only identities for declarations nested inside folds", () => {
    const r = runResolve([
      "resolve",
      "src/control-flow/LocalDeclarations.ts::outer::insideIf",
      "--json",
    ]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as JsonResolveResult;
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0]!.identity.segments).toEqual([{ name: "outer" }, { name: "insideIf" }]);
    expect(parsed.symbols[0]!.identity.segments.map((segment) => segment.name)).not.toContain("if");
  });
});

describe("symnav resolve e2e (fuzzy)", () => {
  it("renders fuzzy payment across all matching files and surfaces the Payment.ts basename match", async () => {
    const r = runResolve(["resolve", "--fuzzy", "payment"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("fuzzy-payment.expected.txt"));
    expect(r.stdout).not.toContain("PayProcessor");
  });
});

describe("symnav resolve e2e (JSON output)", () => {
  it("emits parseable JSON matching the expected object", () => {
    const r = runResolve(["resolve", "PaymentProcessor", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      query: string;
      mode: string;
      symbols: readonly { identity: { file: string } }[];
      files: readonly string[];
    };
    expect(parsed.query).toBe("PaymentProcessor");
    expect(parsed.mode).toBe("exact");
    expect(parsed.files).toEqual([]);
    expect(parsed.symbols.map((s) => s.identity.file)).toEqual([
      "src/exact-fuzzy-regression.ts",
      "src/payments/PaymentProcessor.ts",
    ]);
  });
});
