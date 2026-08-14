import type {
  BackendRouter,
  LanguageBackend,
  ResolvedPath,
  SymbolIdentity,
  SymbolTargetCandidate,
  SymbolTargetRequest,
  Workspace,
} from "@symnav/core";
import {
  AmbiguousSymbolTargetError,
  InvalidSymbolTargetRequestError,
  NoSupportedFilesError,
  SymbolTargetGrammar,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
  SymbolTargetRequestMatcher,
  SymbolTargetRequestParser,
  formatSymbolIdentity,
  isPositiveInteger,
} from "@symnav/core";

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
}

export interface ResolvedCommandTarget {
  readonly identity: SymbolIdentity;
  readonly backend: LanguageBackend;
  readonly files: readonly ResolvedPath[];
}

interface OwnedCandidate {
  readonly candidate: SymbolTargetCandidate;
  readonly backend: LanguageBackend;
}

export class CommandTargetResolver {
  static async resolve(args: ResolveSymbolTargetForCommandArgs): Promise<ResolvedCommandTarget> {
    const containingLine = CommandTargetResolver.containingLineFrom(args.line);
    const request = SymbolTargetRequestParser.parse(args.rawTarget, args.regex);
    const files = await args.workspace.enumerate();
    await CommandTargetResolver.throwIfFileSuffixUnresolvable(args, files, request);
    const acceptedFilesByBackend = CommandTargetResolver.groupFilesByAcceptingBackend(
      args.router,
      files,
    );
    if (acceptedFilesByBackend.size === 0) {
      throw new NoSupportedFilesError();
    }
    const matchedCandidates = await CommandTargetResolver.collectMatchedCandidates(
      acceptedFilesByBackend,
      request,
    );
    if (matchedCandidates.length === 0) {
      throw new SymbolTargetNotFoundError(request.raw);
    }
    const lineCandidates = matchedCandidates.filter((owned) =>
      CommandTargetResolver.matchesLine(containingLine, owned.candidate.symbol),
    );
    if (containingLine !== undefined && lineCandidates.length === 0) {
      throw new SymbolTargetLineMismatchError(request.raw, containingLine);
    }
    const strongestCandidates = CommandTargetResolver.strongestCandidates(lineCandidates, request);
    const sortedOwnedCandidates = [...strongestCandidates].sort((left, right) =>
      left.candidate.canonicalId.localeCompare(right.candidate.canonicalId),
    );
    const winner = sortedOwnedCandidates[0]!;
    if (sortedOwnedCandidates.length > 1) {
      const sortedCandidates = sortedOwnedCandidates.map((owned) => owned.candidate);
      const collapsedIdentity =
        request.mode === "regular"
          ? CommandTargetResolver.collapsedOverloadIdentity(sortedCandidates, request.pattern)
          : undefined;
      if (collapsedIdentity === undefined) {
        throw new AmbiguousSymbolTargetError(request.raw, sortedCandidates);
      }
      return CommandTargetResolver.resolvedTarget(
        collapsedIdentity,
        winner.backend,
        acceptedFilesByBackend,
      );
    }
    return CommandTargetResolver.resolvedTarget(
      winner.candidate.symbol.identity,
      winner.backend,
      acceptedFilesByBackend,
    );
  }

  private static containingLineFrom(
    line: ResolveSymbolTargetForCommandArgs["line"],
  ): number | undefined {
    if (line === undefined) {
      return undefined;
    }
    const numericLine = typeof line === "number" ? line : Number(line);
    if (!isPositiveInteger(numericLine)) {
      throw new InvalidSymbolTargetRequestError(`line must be a positive integer, got ${line}`);
    }
    return numericLine;
  }

  private static resolvedTarget(
    identity: SymbolIdentity,
    backend: LanguageBackend,
    acceptedFilesByBackend: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
  ): ResolvedCommandTarget {
    return { identity, backend, files: acceptedFilesByBackend.get(backend) ?? [] };
  }

  private static async throwIfFileSuffixUnresolvable(
    args: ResolveSymbolTargetForCommandArgs,
    files: readonly ResolvedPath[],
    request: SymbolTargetRequest,
  ): Promise<void> {
    const fileSuffix = request.mode === "regular" ? request.pattern.fileSuffix : undefined;
    if (
      fileSuffix === undefined ||
      files.some((file) => SymbolTargetGrammar.fileSuffixMatches(file.relative, fileSuffix))
    ) {
      return;
    }
    await args.workspace.resolveInputPath(fileSuffix, args.cwd);
  }

  private static groupFilesByAcceptingBackend(
    router: BackendRouter,
    files: readonly ResolvedPath[],
  ): Map<LanguageBackend, ResolvedPath[]> {
    const acceptedFilesByBackend = new Map<LanguageBackend, ResolvedPath[]>();
    for (const file of files) {
      const backend = router.find(file.relative);
      if (backend === undefined) {
        continue;
      }
      const accepted = acceptedFilesByBackend.get(backend);
      if (accepted === undefined) {
        acceptedFilesByBackend.set(backend, [file]);
      } else {
        accepted.push(file);
      }
    }
    return acceptedFilesByBackend;
  }

  private static async collectMatchedCandidates(
    acceptedFilesByBackend: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
    request: SymbolTargetRequest,
  ): Promise<readonly OwnedCandidate[]> {
    const ownedCandidates: OwnedCandidate[] = [];
    for (const [backend, accepted] of acceptedFilesByBackend) {
      const declarations = await backend.declarations(accepted);
      for (const symbol of declarations) {
        if (!SymbolTargetRequestMatcher.matches(request, symbol.identity)) {
          continue;
        }
        ownedCandidates.push({
          candidate: {
            symbol,
            canonicalId: formatSymbolIdentity(symbol.identity),
            header: symbol.header,
          },
          backend,
        });
      }
    }
    return ownedCandidates;
  }

  private static matchesLine(
    containingLine: number | undefined,
    symbol: SymbolTargetCandidate["symbol"],
  ): boolean {
    if (containingLine === undefined) {
      return true;
    }
    return containingLine >= symbol.range.startLine && containingLine <= symbol.range.endLine;
  }

  private static strongestCandidates(
    candidates: readonly OwnedCandidate[],
    request: SymbolTargetRequest,
  ): readonly OwnedCandidate[] {
    if (request.mode === "regex") {
      return candidates;
    }
    let strongestRank = SymbolTargetGrammar.rank(
      request.pattern,
      candidates[0]!.candidate.symbol.identity,
    );
    for (const candidate of candidates.slice(1)) {
      const rank = SymbolTargetGrammar.rank(request.pattern, candidate.candidate.symbol.identity);
      if (SymbolTargetGrammar.compareRanks(rank, strongestRank) > 0) {
        strongestRank = rank;
      }
    }
    return candidates.filter((candidate) => {
      const rank = SymbolTargetGrammar.rank(request.pattern, candidate.candidate.symbol.identity);
      return SymbolTargetGrammar.compareRanks(rank, strongestRank) === 0;
    });
  }

  private static collapsedOverloadIdentity(
    candidates: readonly SymbolTargetCandidate[],
    pattern: Extract<SymbolTargetRequest, { readonly mode: "regular" }>["pattern"],
  ): SymbolIdentity | undefined {
    const leafPattern = pattern.segmentSuffix[pattern.segmentSuffix.length - 1];
    if (leafPattern?.disambiguator !== undefined) {
      return undefined;
    }
    const identities = candidates.map((candidate) =>
      CommandTargetResolver.identityWithoutLeafDisambiguator(candidate.symbol.identity),
    );
    const identityKeys = new Set(identities.map(formatSymbolIdentity));
    if (identityKeys.size !== 1) {
      return undefined;
    }
    return identities[0]!;
  }

  private static identityWithoutLeafDisambiguator(identity: SymbolIdentity): SymbolIdentity {
    const segments = identity.segments.map((segment, index) => {
      if (index !== identity.segments.length - 1 || segment.disambiguator === undefined) {
        return segment;
      }
      return { name: segment.name };
    });
    return { file: identity.file, segments };
  }
}
