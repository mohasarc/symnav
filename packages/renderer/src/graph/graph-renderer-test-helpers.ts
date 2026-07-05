import type {
  EdgeConfidence,
  GraphPath,
  GraphPathStep,
  GraphResult,
  SymbolDecl,
  SymbolPathSegment,
} from "@symnav/core";

export interface DeclInput {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: readonly string[];
}

export function decl(input: DeclInput): SymbolDecl {
  return {
    identity: { file: input.file, segments: input.segments },
    kind: { role: "callable", nativeLabel: "function-implementation" },
    range: { startLine: input.startLine, endLine: input.endLine },
    signature: { startLine: input.startLine, lines: input.signature },
    children: [],
  };
}

export function step(
  symbol: SymbolDecl,
  options: {
    readonly confidence?: EdgeConfidence;
    readonly reason?: string;
    readonly closesCycle?: boolean;
  } = {},
): GraphPathStep {
  return {
    symbol,
    confidence: options.confidence ?? "certain",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    closesCycle: options.closesCycle ?? false,
  };
}

export function path(...steps: readonly GraphPathStep[]): GraphPath {
  return { steps };
}

export function result(
  root: SymbolDecl,
  overrides: Partial<GraphResult> = {},
): GraphResult {
  return {
    identity: root.identity,
    root,
    depth: 2,
    direction: "both",
    incoming: { paths: [], totalPathCount: 0 },
    outgoing: { paths: [], totalPathCount: 0 },
    page: 1,
    pageCount: 1,
    repeatedSymbolCount: 0,
    ...overrides,
  };
}
