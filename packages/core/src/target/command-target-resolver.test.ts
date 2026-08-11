import { describe, expect, it } from "vitest";

import { BackendRouter } from "../backend/backend-router.js";
import type { LanguageBackend } from "../backend/language-backend.js";
import { FileNotFoundError } from "../workspace/errors.js";
import type { ResolvedPath, Workspace } from "../workspace/workspace.js";
import type { CallEdge } from "../intermediate-representation/call-edge.js";
import type { CallTargetResolution } from "../intermediate-representation/call-target.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type {
  OverviewFileEntries,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { SymbolReference } from "../intermediate-representation/references.js";
import type {
  SymbolIdentity,
  SymbolPathSegment,
} from "../intermediate-representation/symbol-identity.js";
import type { Header } from "../intermediate-representation/types.js";
import { CommandTargetResolver } from "./command-target-resolver.js";
import type { ResolvedCommandTarget } from "./command-target-resolver.js";
import { SymbolTargetGrammar } from "./symbol-target-pattern.js";
import type { SymbolTargetPattern } from "./symbol-target-pattern.js";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
} from "./symbol-target-result.js";
import type { SymbolTargetCandidate } from "./symbol-target-result.js";

interface FakeLanguageBackendOptions {
  readonly accept: (filePath: string) => boolean;
  readonly targetCandidates: readonly SymbolTargetCandidate[];
}

class FakeLanguageBackend implements LanguageBackend {
  readonly targetCandidateCalls: string[][] = [];

  constructor(private readonly options: FakeLanguageBackendOptions) {}

  accepts(filePath: string): boolean {
    return this.options.accept(filePath);
  }

  async fileEntries(path: ResolvedPath): Promise<OverviewFileEntries> {
    return { file: path.relative, entries: [] };
  }

  async resolveSymbols(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async findTargetCandidates(
    files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
  ): Promise<readonly SymbolTargetCandidate[]> {
    this.targetCandidateCalls.push(files.map((file) => file.relative));
    return this.options.targetCandidates.filter(
      (candidate) => SymbolTargetGrammar.match(pattern, candidate.symbol.identity) !== undefined,
    );
  }

  async findDefinitions(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async findReferences(): Promise<readonly SymbolReference[]> {
    return [];
  }

  async findCallTarget(): Promise<CallTargetResolution> {
    return { outcome: "not-found" };
  }

  async findCallees(): Promise<readonly CallEdge[]> {
    return [];
  }

  async findCallers(): Promise<readonly CallEdge[]> {
    return [];
  }
}

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
      startLine: 1,
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
      targetCandidates,
    });
  }

  static zetaFake(targetCandidates: readonly SymbolTargetCandidate[]): FakeLanguageBackend {
    return new FakeLanguageBackend({
      accept: (filePath) => filePath.endsWith(".zz"),
      targetCandidates,
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
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map(({ canonicalId }) => canonicalId),
    ).toEqual(["src/alpha.ts::dup", "src/beta.zz::dup"]);
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

  it("hands only suffix-matching files to findTargetCandidates for a file-suffix pattern", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);
    const router = new BackendRouter([typescriptBackend, ResolverScenario.zetaFake([])]);

    const resolved = await ResolverScenario.resolveWith(router, "alpha.ts::walk");

    expect(typescriptBackend.targetCandidateCalls).toEqual([["src/alpha.ts"]]);
    expect(ResolverScenario.relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("hands all accepted files to findTargetCandidates for a bare-name pattern", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
    ]);
    const router = new BackendRouter([typescriptBackend, ResolverScenario.zetaFake([])]);

    const resolved = await ResolverScenario.resolveWith(router, "walk");

    expect(typescriptBackend.targetCandidateCalls).toEqual([["src/alpha.ts", "src/gamma.ts"]]);
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

  it("filters by line after collecting syntax matches across every backend", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }], {
        startLine: 2,
        endLine: 4,
      }),
    ]);
    const zetaBackend = ResolverScenario.zetaFake([
      ResolverScenario.candidateFor("src/beta.zz", [{ name: "walk" }], {
        startLine: 8,
        endLine: 12,
      }),
    ]);
    const router = new BackendRouter([typescriptBackend, zetaBackend]);

    const resolved = await ResolverScenario.resolveWith(router, "walk", 9);

    expect(resolved.backend).toBe(zetaBackend);
    expect(resolved.identity.file).toBe("src/beta.zz");
    expect(typescriptBackend.targetCandidateCalls).toHaveLength(1);
    expect(zetaBackend.targetCandidateCalls).toHaveLength(1);
  });

  it("reports not-found when the target never matched before line filtering", async () => {
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ]),
    ]);

    await expect(ResolverScenario.resolveWith(router, "missing", 99)).rejects.toBeInstanceOf(
      SymbolTargetNotFoundError,
    );
  });

  it("reports line mismatch when line filtering removes syntax matches", async () => {
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]),
      ]),
    ]);

    const error = await ResolverScenario.resolveWith(router, "walk", 99).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SymbolTargetLineMismatchError);
    expect((error as SymbolTargetLineMismatchError).reason).toBe(
      'no symbol target "walk" matching line 99',
    );
  });

  it("preserves ambiguity after line filtering when several candidates contain the line", async () => {
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }], {
          startLine: 1,
          endLine: 5,
        }),
      ]),
      ResolverScenario.zetaFake([
        ResolverScenario.candidateFor("src/beta.zz", [{ name: "walk" }], {
          startLine: 2,
          endLine: 6,
        }),
      ]),
    ]);

    await expect(ResolverScenario.resolveWith(router, "walk", 3)).rejects.toBeInstanceOf(
      AmbiguousSymbolTargetError,
    );
  });

  it.each([
    ["typescript first", ["typescript", "zeta"]],
    ["zeta first", ["zeta", "typescript"]],
  ] as const)(
    "selects the full symbol path across backends with %s",
    async (_label, backendOrder) => {
      const typescriptBackend = ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("src/alpha.ts", [{ name: "Namespace" }, { name: "walk" }]),
      ]);
      const zetaBackend = ResolverScenario.zetaFake([
        ResolverScenario.candidateFor("src/beta.zz", [{ name: "walk" }]),
      ]);
      const backends = backendOrder.map((kind) =>
        kind === "typescript" ? typescriptBackend : zetaBackend,
      );

      const resolved = await ResolverScenario.resolveWith(new BackendRouter(backends), "walk");

      expect(resolved.backend).toBe(zetaBackend);
      expect(resolved.identity).toEqual({ file: "src/beta.zz", segments: [{ name: "walk" }] });
    },
  );

  it("selects an exact file path over a proper file suffix", async () => {
    const exact = ResolverScenario.candidateFor("src/alpha.ts", [{ name: "walk" }]);
    const suffix = ResolverScenario.candidateFor("nested/src/alpha.ts", [{ name: "walk" }]);
    const router = new BackendRouter([ResolverScenario.typescriptFake([suffix, exact])]);

    const resolved = await ResolverScenario.resolveWith(router, "src/alpha.ts::walk", undefined, [
      { relative: "src/alpha.ts", absolute: "/repo/src/alpha.ts" },
      { relative: "nested/src/alpha.ts", absolute: "/repo/nested/src/alpha.ts" },
    ]);

    expect(resolved.identity).toEqual(exact.symbol.identity);
  });

  it("keeps crossed symbol and file specificity ambiguous in canonical-id order", async () => {
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([
        ResolverScenario.candidateFor("orders.ts", [
          { name: "PaymentProcessor" },
          { name: "charge" },
        ]),
        ResolverScenario.candidateFor("src/orders.ts", [{ name: "charge" }]),
      ]),
    ]);

    const error = await ResolverScenario.resolveWith(router, "orders.ts::charge", undefined, [
      { relative: "orders.ts", absolute: "/repo/orders.ts" },
      { relative: "src/orders.ts", absolute: "/repo/src/orders.ts" },
    ]).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AmbiguousSymbolTargetError);
    expect(
      (error as AmbiguousSymbolTargetError).candidates.map((candidate) => candidate.canonicalId),
    ).toEqual(["orders.ts::PaymentProcessor::charge", "src/orders.ts::charge"]);
  });

  it("ranks only candidates retained by line filtering", async () => {
    const weakerLineMatch = ResolverScenario.candidateFor(
      "src/alpha.ts",
      [{ name: "Namespace" }, { name: "walk" }],
      { startLine: 10, endLine: 12 },
    );
    const strongerLineMismatch = ResolverScenario.candidateFor("src/gamma.ts", [{ name: "walk" }], {
      startLine: 20,
      endLine: 22,
    });
    const router = new BackendRouter([
      ResolverScenario.typescriptFake([strongerLineMismatch, weakerLineMatch]),
    ]);

    const resolved = await ResolverScenario.resolveWith(router, "walk", 11);

    expect(resolved.identity).toEqual(weakerLineMatch.symbol.identity);
  });

  it("collapses overload siblings only after removing dominated matches", async () => {
    const typescriptBackend = ResolverScenario.typescriptFake([
      ResolverScenario.candidateFor("src/alpha.ts", [{ name: "Namespace" }, { name: "post" }]),
      ResolverScenario.candidateFor("src/gamma.ts", [{ name: "post", disambiguator: 1 }]),
      ResolverScenario.candidateFor("src/gamma.ts", [{ name: "post", disambiguator: 2 }]),
    ]);

    const resolved = await ResolverScenario.resolveWith(
      new BackendRouter([typescriptBackend]),
      "post",
    );

    expect(resolved.identity).toEqual({ file: "src/gamma.ts", segments: [{ name: "post" }] });
  });

  it("validates unmatched slashless file suffixes as workspace input paths", async () => {
    const resolveInputPathCalls: string[] = [];
    const workspace: Workspace = {
      root: "/repo",
      enumerate: () => Promise.resolve(ResolverScenario.WORKSPACE_FILES),
      resolveInputPath: (inputPath: string) => {
        resolveInputPathCalls.push(inputPath);
        throw new FileNotFoundError(inputPath);
      },
    };

    const resolution = CommandTargetResolver.resolve({
      workspace,
      router: new BackendRouter([ResolverScenario.typescriptFake([])]),
      cwd: "/repo",
      rawTarget: "missing.ts::walk",
      line: undefined,
    });

    await expect(resolution).rejects.toEqual(new FileNotFoundError("missing.ts"));
    expect(resolveInputPathCalls).toEqual(["missing.ts"]);
  });

  it.each(["src/missing.ts", "src\\missing.ts"])(
    "keeps unmatched path-like suffix %s behind workspace input validation",
    async (fileSuffix) => {
      const resolveInputPathCalls: string[] = [];
      const workspace: Workspace = {
        root: "/repo",
        enumerate: () => Promise.resolve(ResolverScenario.WORKSPACE_FILES),
        resolveInputPath: (inputPath: string) => {
          resolveInputPathCalls.push(inputPath);
          throw new FileNotFoundError(inputPath);
        },
      };

      await expect(
        CommandTargetResolver.resolve({
          workspace,
          router: new BackendRouter([ResolverScenario.typescriptFake([])]),
          cwd: "/repo",
          rawTarget: `${fileSuffix}::walk`,
          line: undefined,
        }),
      ).rejects.toBeInstanceOf(FileNotFoundError);
      expect(resolveInputPathCalls).toEqual([fileSuffix]);
    },
  );

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
