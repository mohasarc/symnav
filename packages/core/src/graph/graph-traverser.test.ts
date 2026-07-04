import { describe, expect, it } from "vitest";

import type { LanguageBackend, ResolveSymbolsOptions } from "../backend/language-backend.js";
import type { CallEdge, EdgeConfidence } from "../intermediate-representation/call-edge.js";
import type { CallTargetResolution } from "../intermediate-representation/call-target.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolReference } from "../intermediate-representation/references.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { OverviewFileSymbols, SymbolDecl } from "../intermediate-representation/types.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import { GraphTraverser } from "./graph-traverser.js";

const files: readonly ResolvedPath[] = [];

function symbol(name: string, file = `src/${name}.ts`): SymbolDecl {
  return {
    identity: { file, segments: [{ name }] },
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    signature: { startLine: 1, lines: [`function ${name}()`] },
    children: [],
  };
}

function edge(
  symbolDecl: SymbolDecl,
  confidence: EdgeConfidence = "certain",
  reason?: string,
): CallEdge {
  return {
    symbol: symbolDecl,
    sites: [
      {
        file: "src/root.ts",
        line: 1,
        previewSource: "call()",
        matchStart: 0,
        matchEnd: 4,
      },
    ],
    confidence,
    ...(reason === undefined ? {} : { reason }),
  };
}

function ids(pathSymbols: readonly SymbolDecl[]): readonly string[] {
  return pathSymbols.map((each) => formatSymbolIdentity(each.identity));
}

function pathIds(paths: readonly { readonly steps: readonly { readonly symbol: SymbolDecl }[] }[]) {
  return paths.map((path) => ids(path.steps.map((step) => step.symbol)));
}

class FakeLanguageBackend implements LanguageBackend {
  private readonly callees = new Map<string, readonly CallEdge[]>();
  private readonly callers = new Map<string, readonly CallEdge[]>();

  setCallees(symbolDecl: SymbolDecl, edges: readonly CallEdge[]): void {
    this.callees.set(formatSymbolIdentity(symbolDecl.identity), edges);
  }

  setCallers(symbolDecl: SymbolDecl, edges: readonly CallEdge[]): void {
    this.callers.set(formatSymbolIdentity(symbolDecl.identity), edges);
  }

  accepts(): boolean {
    throw new Error("not implemented");
  }

  fileSymbols(): Promise<OverviewFileSymbols> {
    throw new Error("not implemented");
  }

  resolveSymbols(
    _files: readonly ResolvedPath[],
    _query: string,
    _options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolDecl[]> {
    throw new Error("not implemented");
  }

  findDefinitions(
    _files: readonly ResolvedPath[],
    _identity: SymbolIdentity,
  ): Promise<readonly SymbolDecl[]> {
    throw new Error("not implemented");
  }

  findReferences(
    _files: readonly ResolvedPath[],
    _identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]> {
    throw new Error("not implemented");
  }

  findCallTarget(
    _files: readonly ResolvedPath[],
    _identity: SymbolIdentity,
  ): Promise<CallTargetResolution> {
    throw new Error("not implemented");
  }

  async findCallees(
    _files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return this.callees.get(formatSymbolIdentity(identity)) ?? [];
  }

  async findCallers(
    _files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]> {
    return this.callers.get(formatSymbolIdentity(identity)) ?? [];
  }
}

function traverser(backend: LanguageBackend, root: SymbolDecl, depth: number): GraphTraverser {
  return new GraphTraverser({ backend, files, root, depth });
}

describe("GraphTraverser", () => {
  it("returns depth-one outgoing paths ordered by canonical symbol id", async () => {
    const backend = new FakeLanguageBackend();
    const root = symbol("root");
    const first = symbol("first", "src/a.ts");
    const second = symbol("second", "src/b.ts");
    backend.setCallees(root, [edge(second), edge(first)]);

    const paths = await traverser(backend, root, 1).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([first]), ids([second])]);
    expect(paths[0]!.steps[0]).toEqual({
      symbol: first,
      confidence: "certain",
      closesCycle: false,
    });
  });

  it("extends outgoing chains to the requested depth", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    const b = symbol("b");
    const c = symbol("c");
    const d = symbol("d");
    backend.setCallees(a, [edge(b)]);
    backend.setCallees(b, [edge(c)]);
    backend.setCallees(c, [edge(d)]);

    const paths = await traverser(backend, a, 3).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([b, c, d])]);
  });

  it("stops outgoing chains at the requested depth without marking a cycle", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    const b = symbol("b");
    const c = symbol("c");
    const d = symbol("d");
    backend.setCallees(a, [edge(b)]);
    backend.setCallees(b, [edge(c)]);
    backend.setCallees(c, [edge(d)]);

    const paths = await traverser(backend, a, 2).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([b, c])]);
    expect(paths[0]!.steps[1]!.closesCycle).toBe(false);
  });

  it("terminates outgoing cycles when a chain reaches the root", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    const b = symbol("b");
    backend.setCallees(a, [edge(b)]);
    backend.setCallees(b, [edge(a)]);

    const paths = await traverser(backend, a, 5).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([b, a])]);
    expect(paths[0]!.steps[1]!.closesCycle).toBe(true);
  });

  it("terminates self-recursion as a cycle", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    backend.setCallees(a, [edge(a)]);

    const paths = await traverser(backend, a, 5).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([a])]);
    expect(paths[0]!.steps[0]!.closesCycle).toBe(true);
  });

  it("preserves repeated symbols across diamond paths", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    const b = symbol("b");
    const c = symbol("c");
    const d = symbol("d");
    backend.setCallees(a, [edge(c), edge(b)]);
    backend.setCallees(b, [edge(d)]);
    backend.setCallees(c, [edge(d)]);

    const paths = await traverser(backend, a, 2).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([b, d]), ids([c, d])]);
  });

  it("expands possible outgoing edges and preserves their reason", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    const b = symbol("b");
    const c = symbol("c");
    backend.setCallees(a, [edge(b, "possible", "dynamic dispatch")]);
    backend.setCallees(b, [edge(c)]);

    const paths = await traverser(backend, a, 2).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([b, c])]);
    expect(paths[0]!.steps[0]).toEqual({
      symbol: b,
      confidence: "possible",
      reason: "dynamic dispatch",
      closesCycle: false,
    });
    expect(paths[0]!.steps[1]!.confidence).toBe("certain");
  });

  it("collapses duplicate one-hop targets and prefers certain edges", async () => {
    const backend = new FakeLanguageBackend();
    const a = symbol("a");
    const b = symbol("b");
    backend.setCallees(a, [edge(b, "possible", "dynamic dispatch"), edge(b)]);

    const paths = await traverser(backend, a, 1).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([b])]);
    expect(paths[0]!.steps[0]).toEqual({
      symbol: b,
      confidence: "certain",
      closesCycle: false,
    });
  });

  it("sorts shorter paths before longer paths and ties by canonical ids", async () => {
    const backend = new FakeLanguageBackend();
    const root = symbol("root");
    const firstLeaf = symbol("firstLeaf", "src/a.ts");
    const branch = symbol("branch", "src/b.ts");
    const branchLeaf = symbol("branchLeaf", "src/c.ts");
    const lastLeaf = symbol("lastLeaf", "src/z.ts");
    backend.setCallees(root, [edge(lastLeaf), edge(branch), edge(firstLeaf)]);
    backend.setCallees(branch, [edge(branchLeaf)]);

    const paths = await traverser(backend, root, 2).traverseOutgoing();

    expect(pathIds(paths)).toEqual([ids([firstLeaf]), ids([lastLeaf]), ids([branch, branchLeaf])]);
  });

  it("uses callers for incoming paths", async () => {
    const backend = new FakeLanguageBackend();
    const root = symbol("root");
    const first = symbol("first", "src/a.ts");
    const second = symbol("second", "src/b.ts");
    backend.setCallers(root, [edge(second), edge(first)]);

    const paths = await traverser(backend, root, 1).traverseIncoming();

    expect(pathIds(paths)).toEqual([ids([first]), ids([second])]);
    expect(paths[0]!.steps[0]).toEqual({
      symbol: first,
      confidence: "certain",
      closesCycle: false,
    });
  });
});
