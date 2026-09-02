import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";
import type { JsonIdentity } from "../json-identity.js";

const fixtureRoot = fixturePath("definition-cases");
const snapshotsDir = fileURLToPath(new URL("./__snapshots__/", import.meta.url));

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runDef(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

interface JsonDefResult {
  identity: JsonIdentity;
  symbols: readonly {
    identity: JsonIdentity;
    range: { startLine: number; endLine: number };
  }[];
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav def e2e (overloads)", () => {
  it("returns all three signatures with overload/implementation tags", async () => {
    const r = runDef(["def", "src/http/Router.ts::Router::post"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("router-post.expected.txt"));
  });

  it("with a leaf disambiguator returns exactly that one overload", async () => {
    const r = runDef(["def", "src/http/Router.ts::Router::post#1"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("router-post-leaf.expected.txt"));
  });
});

describe("symnav def e2e (multi-implementation)", () => {
  it("returns the interface declaration plus implementations across files", async () => {
    const r = runDef(["def", "src/payments/PaymentProvider.ts::PaymentProvider::charge"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("payment-provider-charge.expected.txt"));
  });

  it("returns the abstract declaration plus subclass overrides", async () => {
    const r = runDef(["def", "src/shapes/Shape.ts::Shape::area"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot(snapshot("shape-area.expected.txt"));
  });
});

describe("symnav def e2e (errors and empty results)", () => {
  it("rejects a nonexistent file with FileNotFoundError", () => {
    const r = runDef(["def", "src/missing.ts::Whatever"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("file not found");
  });

  it("rejects a path inside an ignored file", () => {
    const r = runDef(["def", "src/ignored-stuff.ts::HiddenDefinition"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("ignored");
  });

  it("rejects a symbol path that matches nothing in the file", () => {
    const r = runDef(["def", "src/namespace-merge/Box.ts::Box::ghost"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      'Cannot answer: no symbol target "src/namespace-merge/Box.ts::Box::ghost" found',
    );
  });

  it("returns definitions for declarations nested inside executable control-flow blocks", () => {
    const r = runDef(["def", "src/control-flow/LocalDeclarations.ts::outer::insideLoop"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/control-flow/LocalDeclarations.ts");
    expect(r.stdout).toContain("8: outer::insideLoop");
    expect(r.stdout).toContain("const insideLoop = item");
    expect(r.stdout).not.toContain("for::insideLoop");
  });

  it("emits declaration-only identities for definitions nested inside folds", () => {
    const r = runDef(["def", "src/control-flow/LocalDeclarations.ts::outer::insideLoop", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as JsonDefResult;
    expect(parsed.identity).toEqual({
      file: "src/control-flow/LocalDeclarations.ts",
      segments: [{ name: "outer" }, { name: "insideLoop" }],
    });
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0]!.identity.segments).toEqual([
      { name: "outer" },
      { name: "insideLoop" },
    ]);
    expect(parsed.symbols[0]!.range).toEqual({ startLine: 8, endLine: 8 });
  });
});

describe("symnav def e2e (JSON output)", () => {
  it("emits parseable JSON matching the expected object", () => {
    const r = runDef(["def", "src/http/Router.ts::Router::post#1", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      identity: { file: string; path: readonly { name: string; disambiguator?: number }[] };
      symbols: readonly {
        identity: { file: string; path: readonly { name: string; disambiguator?: number }[] };
        kind: { nativeLabel: string; role: string };
      }[];
    };
    expect(parsed.identity).toEqual({
      file: "src/http/Router.ts",
      segments: [{ name: "Router" }, { name: "post", disambiguator: 1 }],
    });
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0]!.kind.nativeLabel).toBe("method-overload-signature");
  });
});
