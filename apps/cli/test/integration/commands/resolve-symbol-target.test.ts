import { describe, expect, it } from "vitest";
import {
  AmbiguousSymbolTargetError,
  BackendRouter,
  InMemoryFileSystem,
  SymbolTargetNotFoundError,
  SymbolTargetLineMismatchError,
  formatSymbolIdentity,
} from "@symnav/core";
import type {
  Header,
  ResolvedPath,
  SymbolIdentity,
  SymbolPathSegment,
  SymbolTargetCandidate,
  Workspace,
} from "@symnav/core";

import { runCommand } from "../../../src/command.js";
import { defCommand } from "../../../src/commands/def/def-command.js";
import { CommandTargetResolver } from "../../../src/commands/resolve-symbol-target.js";
import type { ResolvedCommandTarget } from "../../../src/commands/resolve-symbol-target.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";
import { fakeDependencies } from "./helpers/fake-program-dependencies.js";

class ResolverScenario {
  private static readonly WORKSPACE_FILES: readonly ResolvedPath[] = [
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
  ): Promise<ResolvedCommandTarget> {
    return CommandTargetResolver.resolve({
      workspace: ResolverScenario.fakeWorkspace(files),
      router,
      cwd: "/repo",
      rawTarget,
      line,
    });
  }

  static relativeFiles(resolved: ResolvedCommandTarget): readonly string[] {
    return resolved.files.map((file) => file.relative);
  }

  private static fakeWorkspace(files: readonly ResolvedPath[]): Workspace {
    return {
      root: "/repo",
      resolveInputPath: (inputPath: string) => {
        throw new Error(`unexpected resolveInputPath: ${inputPath}`);
      },
      enumerate: () => Promise.resolve(files),
    };
  }
}

describe("CommandTargetResolver.resolve across backends", () => {
  it("selects a full symbol path over a proper suffix", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "charge" }]),
      ResolverScenario.candidateFor("src/gamma.ts", [
        { name: "PaymentProcessor" },
        { name: "charge" },
      ]),
    ]);

    const resolved = await ResolverScenario.resolveWith(new BackendRouter([backend]), "charge");

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "charge" }] });
  });

  it("selects an exact file path over a proper suffix", async () => {
    const files = [
      { relative: "src/alpha.ts", absolute: "/repo/src/alpha.ts" },
      { relative: "vendor/src/alpha.ts", absolute: "/repo/vendor/src/alpha.ts" },
    ];
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ResolverScenario.candidateFor("vendor/src/alpha.ts", [{ name: "walk" }]),
    ]);

    const resolved = await ResolverScenario.resolveWith(
      new BackendRouter([backend]),
      "src/alpha.ts::walk",
      undefined,
      files,
    );

    expect(resolved.identity.file).toBe("src/alpha.ts");
  });

  it("uses symbol specificity before file specificity", async () => {
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

  it("applies line narrowing before ranking", async () => {
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

  it("collapses overload siblings only inside the strongest rank", async () => {
    const backend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 1 }]),
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 2 }]),
      ResolverScenario.candidateFor("src/gamma.ts", [
        { name: "Router" },
        { name: "post", disambiguator: 1 },
      ]),
    ]);

    const resolved = await ResolverScenario.resolveWith(new BackendRouter([backend]), "post");

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "post" }] });
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

  it("reports a workspace whose files no backend supports", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(defCommand, {
      context,
      dependencies: fakeDependencies({
        fs: new InMemoryFileSystem({
          "/repo/.git/HEAD": "ref: refs/heads/main\n",
          "/repo/README.md": "docs only\n",
        }),
        backends: () => [new FakeLanguageBackend({ accept: () => false })],
      }),
      cwdOverride: undefined,
      json: false,
      args: { target: "helper", line: undefined },
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: workspace contains no files supported by any language backend.\n",
    );
    expect(context.exitCodes).toEqual([1]);
  });

  it("rejects a malformed --line value echoing the raw input", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(defCommand, {
      context,
      dependencies: fakeDependencies({
        fs: new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" }),
        backends: () => [
          ResolverScenario.typescriptFake([
            ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
          ]),
        ],
      }),
      cwdOverride: undefined,
      json: false,
      args: { target: "walk", line: "abc" },
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: line must be a positive integer, got abc.\n",
    );
    expect(context.exitCodes).toEqual([1]);
  });

  it("rejects a non-positive --line value echoing the raw input", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(defCommand, {
      context,
      dependencies: fakeDependencies({
        fs: new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" }),
        backends: () => [
          ResolverScenario.typescriptFake([
            ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
          ]),
        ],
      }),
      cwdOverride: undefined,
      json: false,
      args: { target: "walk", line: "0" },
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("Cannot answer: line must be a positive integer, got 0.\n");
    expect(context.exitCodes).toEqual([1]);
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
});
