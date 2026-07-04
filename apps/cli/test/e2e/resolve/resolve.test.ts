import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("resolve-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runResolve(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav resolve e2e (exact)", () => {
  it("renders exact PaymentProcessor", async () => {
    const r = runResolve(["resolve", "PaymentProcessor"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("exact-payment-processor.expected.txt"));
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

  it.skip("finds declarations nested inside executable control-flow blocks", () => {
    const r = runResolve(["resolve", "insideIf"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/control-flow/LocalDeclarations.ts");
    expect(r.stdout).toContain("outer::insideIf");
  });
});

describe("symnav resolve e2e (fuzzy)", () => {
  it("renders fuzzy payment across all matching files and surfaces the Payment.ts basename match", async () => {
    const r = runResolve(["resolve", "--fuzzy", "payment"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("fuzzy-payment.expected.txt"));
  });
});

describe("symnav resolve e2e (JSON output)", () => {
  it("emits parseable JSON matching the expected object", () => {
    const r = runResolve(["resolve", "PaymentProcessor", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      query: string;
      fuzzy: boolean;
      symbols: readonly { identity: { file: string } }[];
      files: readonly string[];
    };
    expect(parsed.query).toBe("PaymentProcessor");
    expect(parsed.fuzzy).toBe(false);
    expect(parsed.files).toEqual([]);
    expect(parsed.symbols.map((s) => s.identity.file)).toEqual([
      "src/payments/PaymentProcessor.ts",
    ]);
  });
});
