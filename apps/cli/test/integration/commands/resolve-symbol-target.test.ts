import { describe, expect, it } from "vitest";
import {
  AmbiguousSymbolTargetError,
  BackendRouter,
  SymbolTargetNotFoundError,
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

import { resolveSymbolTargetForCommand } from "../../../src/commands/resolve-symbol-target.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";

const WORKSPACE_FILES: readonly ResolvedPath[] = [
  { relative: "src/alpha.ts", absolute: "/repo/src/alpha.ts" },
  { relative: "src/beta.zz", absolute: "/repo/src/beta.zz" },
];

function fakeWorkspace(files: readonly ResolvedPath[]): Workspace {
  return {
    root: "/repo",
    resolveInputPath: (inputPath: string) => {
      throw new Error(`unexpected resolveInputPath: ${inputPath}`);
    },
    enumerate: () => Promise.resolve(files),
  };
}

function candidateFor(file: string, segments: readonly SymbolPathSegment[]): SymbolTargetCandidate {
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
      range: { startLine: 1, endLine: 1 },
      header,
    },
    canonicalId: formatSymbolIdentity(identity),
    header,
  };
}

function typescriptFake(targetCandidates: readonly SymbolTargetCandidate[]): FakeLanguageBackend {
  return new FakeLanguageBackend({
    accept: (filePath) => filePath.endsWith(".ts"),
    targetCandidates,
  });
}

function zetaFake(targetCandidates: readonly SymbolTargetCandidate[]): FakeLanguageBackend {
  return new FakeLanguageBackend({
    accept: (filePath) => filePath.endsWith(".zz"),
    targetCandidates,
  });
}

function resolveWith(router: BackendRouter, rawTarget: string): Promise<SymbolIdentity> {
  return resolveSymbolTargetForCommand({
    workspace: fakeWorkspace(WORKSPACE_FILES),
    router,
    cwd: "/repo",
    rawTarget,
    containingLine: undefined,
  });
}

describe("resolveSymbolTargetForCommand across backends", () => {
  it("resolves a bare name unique to one backend while another backend's files exist", async () => {
    const router = new BackendRouter([
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]),
      zetaFake([candidateFor("src/beta.zz", [{ name: "other" }])]),
    ]);

    const identity = await resolveWith(router, "walk");

    expect(identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "walk" }] });
  });

  it("reports ambiguity listing candidates from both backends sorted by canonical id", async () => {
    const router = new BackendRouter([
      zetaFake([candidateFor("src/beta.zz", [{ name: "dup" }])]),
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "dup" }])]),
    ]);

    const error = await resolveWith(router, "dup").then(
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
    const router = new BackendRouter([
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "dup" }])]),
      zetaFake([candidateFor("src/beta.zz", [{ name: "dup" }])]),
    ]);

    const identity = await resolveWith(router, "beta.zz::dup");

    expect(identity).toEqual({ file: "src/beta.zz", segments: [{ name: "dup" }] });
  });

  it("throws not-found when no backend has a matching candidate", async () => {
    const router = new BackendRouter([
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]),
      zetaFake([candidateFor("src/beta.zz", [{ name: "other" }])]),
    ]);

    await expect(resolveWith(router, "missing")).rejects.toBeInstanceOf(SymbolTargetNotFoundError);
  });

  it("collapses overload candidates to the disambiguator-stripped identity", async () => {
    const router = new BackendRouter([
      typescriptFake([
        candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 1 }]),
        candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 2 }]),
      ]),
      zetaFake([]),
    ]);

    const identity = await resolveWith(router, "post");

    expect(identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "post" }] });
  });
});
