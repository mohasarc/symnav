import type {
  FileSystem,
  ResolvedPath,
  ResolveSymbolTargetOptions,
  SymbolOverviewNode,
  SymbolTargetCandidate,
  SymbolTargetPattern,
} from "@symnav/core";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetNotFoundError,
  formatSymbolIdentity,
  symbolTargetMatches,
  OverviewTree,
} from "@symnav/core";
import type { SymbolIdentity } from "@symnav/core";

import { loadFileEntries } from "../extract/load-file-entries.js";

export interface ResolveSymbolTargetArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly pattern: SymbolTargetPattern;
  readonly options: ResolveSymbolTargetOptions;
}

export async function resolveSymbolTarget(
  args: ResolveSymbolTargetArgs,
): Promise<SymbolOverviewNode> {
  const candidates = extractMatchingCandidates(args);
  if (candidates.length === 0) {
    throw new SymbolTargetNotFoundError(args.pattern);
  }
  if (candidates.length > 1) {
    const group = overloadGroupCandidate(candidates, args.pattern);
    if (group !== undefined) {
      return group;
    }
    throw new AmbiguousSymbolTargetError(args.pattern, candidates);
  }
  return candidates[0]!.symbol;
}

function overloadGroupCandidate(
  candidates: readonly SymbolTargetCandidate[],
  pattern: SymbolTargetPattern,
): SymbolOverviewNode | undefined {
  const leafPattern = pattern.segmentSuffix[pattern.segmentSuffix.length - 1];
  if (leafPattern?.disambiguator !== undefined) {
    return undefined;
  }
  const identities = candidates.map((candidate) =>
    identityWithoutLeafDisambiguator(candidate.symbol.identity),
  );
  const identityKeys = new Set(identities.map(formatSymbolIdentity));
  if (identityKeys.size !== 1) {
    return undefined;
  }
  return { ...candidates[0]!.symbol, identity: identities[0]! };
}

function identityWithoutLeafDisambiguator(identity: SymbolIdentity): SymbolIdentity {
  const segments = identity.segments.map((segment, index) => {
    if (index !== identity.segments.length - 1 || segment.disambiguator === undefined) {
      return segment;
    }
    return { name: segment.name };
  });
  return { file: identity.file, segments };
}

function extractMatchingCandidates(
  args: ResolveSymbolTargetArgs,
): readonly SymbolTargetCandidate[] {
  const candidates: SymbolTargetCandidate[] = [];
  for (const file of args.files) {
    for (const symbol of OverviewTree.walkSymbols(loadFileEntries(args.fs, file).entries)) {
      if (!symbolTargetMatches(args.pattern, symbol.identity)) continue;
      if (!matchesLine(args.options.containingLine, symbol)) continue;
      candidates.push({
        symbol,
        canonicalId: formatSymbolIdentity(symbol.identity),
        header: symbol.header,
      });
    }
  }
  return candidates.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
}

function matchesLine(line: number | undefined, symbol: SymbolOverviewNode): boolean {
  if (line === undefined) {
    return true;
  }
  return line >= symbol.range.startLine && line <= symbol.range.endLine;
}
