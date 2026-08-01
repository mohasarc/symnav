import { describe, expect, it } from "vitest";
import {
  AmbiguousSymbolTargetError,
  BackendRouter,
  InMemoryFileSystem,
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

import { runCommand } from "../../../src/command.js";
import { defCommand } from "../../../src/commands/def/def-command.js";
import { CommandTargetResolver } from "../../../src/commands/resolve-symbol-target.js";
import type { ResolvedCommandTarget } from "../../../src/commands/resolve-symbol-target.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";
import { fakeDependencies } from "./helpers/fake-program-dependencies.js";

const WORKSPACE_FILES: readonly ResolvedPath[] = [
  { relative: "src/alpha.ts", absolute: "/repo/src/alpha.ts" },
  { relative: "src/beta.zz", absolute: "/repo/src/beta.zz" },
  { relative: "src/gamma.ts", absolute: "/repo/src/gamma.ts" },
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

function resolveWith(router: BackendRouter, rawTarget: string): Promise<ResolvedCommandTarget> {
  return CommandTargetResolver.resolve({
    workspace: fakeWorkspace(WORKSPACE_FILES),
    router,
    cwd: "/repo",
    rawTarget,
    line: undefined,
  });
}

function relativeFiles(resolved: ResolvedCommandTarget): readonly string[] {
  return resolved.files.map((file) => file.relative);
}

describe("CommandTargetResolver.resolve across backends", () => {
  it("resolves a bare name unique to one backend while another backend's files exist", async () => {
    const typescriptBackend = typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]);
    const router = new BackendRouter([
      typescriptBackend,
      zetaFake([candidateFor("src/beta.zz", [{ name: "other" }])]),
    ]);

    const resolved = await resolveWith(router, "walk");

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "walk" }] });
    expect(resolved.backend).toBe(typescriptBackend);
    expect(relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
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
    const zetaBackend = zetaFake([candidateFor("src/beta.zz", [{ name: "dup" }])]);
    const router = new BackendRouter([
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "dup" }])]),
      zetaBackend,
    ]);

    const resolved = await resolveWith(router, "beta.zz::dup");

    expect(resolved.identity).toEqual({ file: "src/beta.zz", segments: [{ name: "dup" }] });
    expect(resolved.backend).toBe(zetaBackend);
    expect(relativeFiles(resolved)).toEqual(["src/beta.zz"]);
  });

  it("hands only suffix-matching files to findTargetCandidates for a file-suffix pattern", async () => {
    const typescriptBackend = typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]);
    const router = new BackendRouter([typescriptBackend, zetaFake([])]);

    const resolved = await resolveWith(router, "alpha.ts::walk");

    expect(typescriptBackend.targetCandidateCalls).toEqual([["src/alpha.ts"]]);
    expect(relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("hands all accepted files to findTargetCandidates for a bare-name pattern", async () => {
    const typescriptBackend = typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]);
    const router = new BackendRouter([typescriptBackend, zetaFake([])]);

    const resolved = await resolveWith(router, "walk");

    expect(typescriptBackend.targetCandidateCalls).toEqual([["src/alpha.ts", "src/gamma.ts"]]);
    expect(relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("keeps the full backend-accepted file list for a file-suffix pattern", async () => {
    const router = new BackendRouter([
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]),
      zetaFake([]),
    ]);

    const resolved = await resolveWith(router, "alpha.ts::walk");

    expect(relativeFiles(resolved)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("throws not-found when no backend has a matching candidate", async () => {
    const router = new BackendRouter([
      typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])]),
      zetaFake([candidateFor("src/beta.zz", [{ name: "other" }])]),
    ]);

    await expect(resolveWith(router, "missing")).rejects.toBeInstanceOf(SymbolTargetNotFoundError);
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
        backends: () => [typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])])],
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
        backends: () => [typescriptFake([candidateFor("src/alpha.ts", [{ name: "walk" }])])],
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
    const typescriptBackend = typescriptFake([
      candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 1 }]),
      candidateFor("src/alpha.ts", [{ name: "post", disambiguator: 2 }]),
    ]);
    const router = new BackendRouter([typescriptBackend, zetaFake([])]);

    const resolved = await resolveWith(router, "post");

    expect(resolved.identity).toEqual({ file: "src/alpha.ts", segments: [{ name: "post" }] });
    expect(resolved.backend).toBe(typescriptBackend);
  });
});
