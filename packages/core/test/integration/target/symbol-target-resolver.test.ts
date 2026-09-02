import { describe, expect, it } from "vitest";

import { BackendRouter } from "../../../src/backend/backend-router.js";
import { formatSymbolIdentity } from "../../../src/intermediate-representation/canonical-identity.js";
import type { Header } from "../../../src/intermediate-representation/types.js";
import type {
  SymbolIdentity,
  SymbolPathSegment,
} from "../../../src/intermediate-representation/symbol-identity.js";
import { SymbolTargetResolver } from "../../../src/target/symbol-target-resolver.js";
import type { ResolvedSymbolTarget } from "../../../src/target/symbol-target-resolver.js";
import type { SymbolTargetCandidate } from "../../../src/target/symbol-target-result.js";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
} from "../../../src/target/symbol-target-result.js";
import type { ResolvedPath, Workspace } from "../../../src/workspace/workspace.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";

class ResolverScenario {
  static readonly WORKSPACE_FILES: readonly ResolvedPath[] = [
    { relative: "src/alpha.ts", absolute: "/repo/src/alpha.ts" },
    { relative: "src/beta.zz", absolute: "/repo/src/beta.zz" },
    { relative: "src/gamma.ts", absolute: "/repo/src/gamma.ts" },
  ];

  static candidateFor(
    file: string,
    segments: readonly SymbolPathSegment[],
    range: { readonly startLine: number; readonly endLine: number } = {
      startLine: 1,
      endLine: 1,
    },
  ): SymbolTargetCandidate {
    const identity: SymbolIdentity = { file, segments };
    const header: Header = {
      startLine: range.startLine,
      lines: [`declare ${segments.map((segment) => segment.name).join(".")}`],
    };
    return {
      symbol: {
        type: "symbol",
        identity,
        kind: { role: "callable", nativeLabel: "function" },
        children: [],
        range,
        header,
      },
      canonicalId: formatSymbolIdentity(identity),
      header,
    };
  }

  static typescriptFake(targetCandidates: readonly SymbolTargetCandidate[]): FakeLanguageBackend {
    return new FakeLanguageBackend({
      accept: (filePath) => filePath.endsWith(".ts"),
      declarations: targetCandidates.map((candidate) => candidate.symbol),
    });
  }

  static zetaFake(targetCandidates: readonly SymbolTargetCandidate[]): FakeLanguageBackend {
    return new FakeLanguageBackend({
      accept: (filePath) => filePath.endsWith(".zz"),
      declarations: targetCandidates.map((candidate) => candidate.symbol),
    });
  }

  static resolveWith(
    router: BackendRouter,
    rawTarget: string,
    line: number | string | undefined = undefined,
    files: readonly ResolvedPath[] = ResolverScenario.WORKSPACE_FILES,
    regex = false,
  ): Promise<ResolvedSymbolTarget> {
    return SymbolTargetResolver.resolve({
      workspace: ResolverScenario.fakeWorkspace(files),
      router,
      cwd: "/repo",
      rawTarget,
      line,
      regex,
    });
  }

  static relativeFiles(resolved: ResolvedSymbolTarget): readonly string[] {
    return resolved.files.map((file) => file.relative);
  }

  private static fakeWorkspace(files: readonly ResolvedPath[]): Workspace {
    const workspaceFiles = files.map((file) => ({
      ...file,
      metadata: { size: 0, modifiedAtMs: 0, changeToken: "revision-1" },
    }));
    return {
      root: "/repo",
      resolveInputPath: (inputPath: string) => {
        throw new Error(`unexpected resolveInputPath: ${inputPath}`);
      },
      enumerate: () => Promise.resolve(workspaceFiles),
      snapshot: () => Promise.resolve({ root: "/repo", files: workspaceFiles }),
    };
  }
}

describe("SymbolTargetResolver.resolve across backends", () => {
  it("keeps a bare name ambiguous across a top-level and a nested symbol", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "charge" }]),
      ResolverScenario.candidateFor("src/gamma.ts", [
        { name: "PaymentProcessor" },
        { name: "charge" },
      ]),
    ]);

    const error = await ResolverScenario.resolveWith(new BackendRouter([backend]), "charge").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map((candidate) => candidate.canonicalId),
    ).toEqual(["src/alpha.ts::charge", "src/gamma.ts::PaymentProcessor::charge"]);
  });
  it("keeps a file-suffix target ambiguous when a longer path also ends with it", async () => {
    const files = [
      { relative: "src/alpha.ts", absolute: "/repo/src/alpha.ts" },
      { relative: "vendor/src/alpha.ts", absolute: "/repo/vendor/src/alpha.ts" },
    ];
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ResolverScenario.candidateFor("vendor/src/alpha.ts", [{ name: "walk" }]),
    ]);

    const error = await ResolverScenario.resolveWith(
      new BackendRouter([backend]),
      "src/alpha.ts::walk",
      undefined,
      files,
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map((candidate) => candidate.canonicalId),
    ).toEqual(["src/alpha.ts::walk", "vendor/src/alpha.ts::walk"]);
  });
  it("resolves a target that only one canonical id ends with", async () => {
    const files = [
      { relative: "orders.ts", absolute: "/repo/orders.ts" },
      { relative: "src/orders.ts", absolute: "/repo/src/orders.ts" },
    ];
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/orders.ts", [{ name: "charge" }]),
      ResolverScenario.candidateFor("orders.ts", [
        { name: "PaymentProcessor" },
        { name: "charge" },
      ]),
    ]);

    const resolved = await ResolverScenario.resolveWith(
      new BackendRouter([backend]),
      "orders.ts::charge",
      undefined,
      files,
    );

    expect(resolved.identity).toEqual({ file: "src/orders.ts", segments: [{ name: "charge" }] });
  });
  it("keeps equally strong candidates ambiguous in canonical-id order", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/gamma.ts", [{ name: "walk" }]),
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);

    const error = await ResolverScenario.resolveWith(new BackendRouter([backend]), "walk").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map((candidate) => candidate.canonicalId),
    ).toEqual(["src/alpha.ts::walk", "src/gamma.ts::walk"]);
  });
  it("narrows by line before reporting ambiguity", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "charge" }], {
        startLine: 1,
        endLine: 2,
      }),
      ResolverScenario.candidateFor(
        "src/gamma.ts",
        [{ name: "PaymentProcessor" }, { name: "charge" }],
        { startLine: 5, endLine: 8 },
      ),
    ]);

    const resolved = await ResolverScenario.resolveWith(new BackendRouter([backend]), "charge", 6);

    expect(resolved.identity.file).toBe("src/gamma.ts");
  });
  it("distinguishes a line-filtered match from a missing target", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);

    await expect(
      ResolverScenario.resolveWith(new BackendRouter([backend]), "walk", 99),
    ).rejects.toBeInstanceOf(SymbolTargetLineMismatchError);
    await expect(
      ResolverScenario.resolveWith(new BackendRouter([backend]), "missing", 99),
    ).rejects.toBeInstanceOf(SymbolTargetNotFoundError);
  });
  it("refuses to collapse overloads spread across distinct symbols", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 1 }]),
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 2 }]),
      ResolverScenario.candidateFor("src/gamma.ts", [
        { name: "Router" },
        { name: "post", disambiguator: 1 },
      ]),
    ]);

    const error = await ResolverScenario.resolveWith(new BackendRouter([backend]), "post").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map((candidate) => candidate.canonicalId),
    ).toEqual(["src/alpha.ts::post#1", "src/alpha.ts::post#2", "src/gamma.ts::Router::post#1"]);
  });
  it("resolves a bare name unique to one backend while another backend's files exist", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);
    const router = new BackendRouter([
      typescriptBackend,
      ResolverScenario.zetaFake([
        ResolverScenario.candidateFor("src/beta.zz", [{ name: "other" }]),
      ]),
    ]);

    const resolved = await ResolverScenario.resolveWith(router, "walk");

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "walk" }] });
    expect(resolved.backend).toBe(typescriptBackend);
    expect(ResolverScenario.relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });
  it("reports ambiguity listing candidates from both backends sorted by canonical id", async () => {
    const router = new BackendRouter([
      ResolverScenario.zetaFake([ResolverScenario.candidateFor("src/beta.zz", [{ name: "dup" }])]),
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "dup" }]),
      ]),
    ]);

    const error = await ResolverScenario.resolveWith(router, "dup").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    const ambiguous = error as AmbiguousSymbolTargetError;
    expect(ambiguous.candidates.map((candidate) => candidate.canonicalId)).toEqual([
      "src/alpha.ts::dup",
      "src/beta.zz::dup",
    ]);
  });
  it("routes a file-suffix pattern to the matching backend's candidate", async () => {
    const zetaBackend = ResolverScenario.zetaFake([
      ResolverScenario.candidateFor("src/beta.zz", [{ name: "dup" }]),
    ]);
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "dup" }]),
      ]),
      zetaBackend,
    ]);

    const resolved = await ResolverScenario.resolveWith(router, "beta.zz::dup");

    expect(resolved.identity).toEqual({ file: "src/beta.zz", segments: [{ name: "dup" }] });
    expect(resolved.backend).toBe(zetaBackend);
    expect(ResolverScenario.relativeFiles(resolved)).toEqual(["src/beta.zz"]);
  });
  it("enumerates each backend's accepted files once for a file-suffix pattern", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);
    const router = new BackendRouter([typescriptBackend, ResolverScenario.zetaFake([])]);

    const resolved = await ResolverScenario.resolveWith(router, "alpha.ts::walk");

    expect(typescriptBackend.declarationCalls).toEqual([["src/alpha.ts", "src/gamma.ts"]]);
    expect(ResolverScenario.relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });
  it("enumerates each backend's accepted files once for a bare-name pattern", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);
    const router = new BackendRouter([typescriptBackend, ResolverScenario.zetaFake([])]);

    const resolved = await ResolverScenario.resolveWith(router, "walk");

    expect(typescriptBackend.declarationCalls).toEqual([["src/alpha.ts", "src/gamma.ts"]]);
    expect(ResolverScenario.relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });
  it("keeps the full backend-accepted file list for a file-suffix pattern", async () => {
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ]),
      ResolverScenario.zetaFake([]),
    ]);

    const resolved = await ResolverScenario.resolveWith(router, "alpha.ts::walk");

    expect(ResolverScenario.relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });
  it("throws not-found when no backend has a matching candidate", async () => {
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ]),
      ResolverScenario.zetaFake([
        ResolverScenario.candidateFor("src/beta.zz", [{ name: "other" }]),
      ]),
    ]);

    await expect(ResolverScenario.resolveWith(router, "missing")).rejects.toBeInstanceOf(
      SymbolTargetNotFoundError,
    );
  });
  it("collapses overload candidates to the disambiguator-stripped identity", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 1 }]),
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 2 }]),
    ]);
    const router = new BackendRouter([typescriptBackend, ResolverScenario.zetaFake([])]);

    const resolved = await ResolverScenario.resolveWith(router, "post");

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "post" }] });
    expect(resolved.backend).toBe(typescriptBackend);
  });
  it("resolves one regex match against a full canonical id", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ResolverScenario.candidateFor("src/gamma.ts", [{ name: "other" }]),
    ]);

    const resolved = await ResolverScenario.resolveWith(
      new BackendRouter([backend]),
      "^src/alpha\\.ts::walk$",
      undefined,
      ResolverScenario.WORKSPACE_FILES,
      true,
    );

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "walk" }] });
  });
  it("reports not-found when a regex matches no canonical ids", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);

    await expect(
      ResolverScenario.resolveWith(
        new BackendRouter([backend]),
        "missing$",
        undefined,
        ResolverScenario.WORKSPACE_FILES,
        true,
      ),
    ).rejects.toBeInstanceOf(SymbolTargetNotFoundError);
  });
  it("keeps every surviving regex candidate equally ambiguous", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "charge" }]),
      ResolverScenario.candidateFor("src/gamma.ts", [
        { name: "PaymentProcessor" },
        { name: "charge" },
      ]),
    ]);

    const error = await ResolverScenario.resolveWith(
      new BackendRouter([backend]),
      "charge$",
      undefined,
      ResolverScenario.WORKSPACE_FILES,
      true,
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map((candidate) => candidate.canonicalId),
    ).toEqual(["src/alpha.ts::charge", "src/gamma.ts::PaymentProcessor::charge"]);
  });
  it("applies line narrowing after regex matching", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "charge" }], {
        startLine: 1,
        endLine: 2,
      }),
      ResolverScenario.candidateFor("src/gamma.ts", [{ name: "charge" }], {
        startLine: 5,
        endLine: 8,
      }),
    ]);

    const resolved = await ResolverScenario.resolveWith(
      new BackendRouter([backend]),
      "charge$",
      6,
      ResolverScenario.WORKSPACE_FILES,
      true,
    );

    expect(resolved.identity.file).toBe("src/gamma.ts");
  });
  it("reports line mismatch when narrowing removes every regex match", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);

    await expect(
      ResolverScenario.resolveWith(
        new BackendRouter([backend]),
        "walk$",
        99,
        ResolverScenario.WORKSPACE_FILES,
        true,
      ),
    ).rejects.toBeInstanceOf(SymbolTargetLineMismatchError);
  });
  it("does not collapse regex matches for overload siblings", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 1 }]),
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 2 }]),
    ]);

    await expect(
      ResolverScenario.resolveWith(
        new BackendRouter([backend]),
        "post#(?:1|2)$",
        undefined,
        ResolverScenario.WORKSPACE_FILES,
        true,
      ),
    ).rejects.toBeInstanceOf(AmbiguousSymbolTargetError);
  });
  it("enumerates all backend-accepted files for regex requests", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);

    await ResolverScenario.resolveWith(
      new BackendRouter([typescriptBackend]),
      "alpha\\.ts::walk$",
      undefined,
      ResolverScenario.WORKSPACE_FILES,
      true,
    );

    expect(typescriptBackend.declarationCalls).toEqual([["src/alpha.ts", "src/gamma.ts"]]);
  });
});
