import { BackendRouter } from "../backend/backend-router.js";
import { NoSupportedFilesError } from "../backend/errors.js";
import type { LanguageBackend } from "../backend/language-backend.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import { isPositiveInteger } from "../validation/is-positive-integer.js";
import type { ResolvedPath, Workspace } from "../workspace/workspace.js";
import { SymbolTargetGrammar } from "./symbol-target-pattern.js";
import type { SymbolTargetPattern, SymbolTargetSpecificity } from "./symbol-target-pattern.js";
import {
  AmbiguousSymbolTargetError,
  InvalidSymbolTargetRequestError,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
} from "./symbol-target-result.js";
import type { SymbolTargetCandidate } from "./symbol-target-result.js";

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | string | undefined;
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

interface OwnedCandidateMatch {
  readonly ownedCandidate: OwnedCandidate;
  readonly specificity: SymbolTargetSpecificity;
}

export class CommandTargetResolver {
  static async resolve(args: ResolveSymbolTargetForCommandArgs): Promise<ResolvedCommandTarget> {
    const containingLine = CommandTargetResolver.containingLineFrom(args.line);
    const pattern = SymbolTargetGrammar.parse(args.rawTarget);
    const files = await args.workspace.enumerate();
    await CommandTargetResolver.throwIfFileSuffixUnresolvable(args, files, pattern.fileSuffix);
    const acceptedFilesByBackend = CommandTargetResolver.groupFilesByAcceptingBackend(
      args.router,
      files,
    );
    if (acceptedFilesByBackend.size === 0) {
      throw new NoSupportedFilesError();
    }
    const ownedCandidates = await CommandTargetResolver.collectCandidates(
      acceptedFilesByBackend,
      pattern,
    );
    if (ownedCandidates.length === 0) {
      throw new SymbolTargetNotFoundError(args.rawTarget);
    }
    const lineMatchedCandidates =
      containingLine === undefined
        ? ownedCandidates
        : ownedCandidates.filter(
            ({ candidate }) =>
              containingLine >= candidate.symbol.range.startLine &&
              containingLine <= candidate.symbol.range.endLine,
          );
    if (lineMatchedCandidates.length === 0 && containingLine !== undefined) {
      throw new SymbolTargetLineMismatchError(args.rawTarget, containingLine);
    }
    const strongestOwnedCandidates = CommandTargetResolver.nonDominatedCandidates(
      lineMatchedCandidates,
      pattern,
    );
    const sortedOwnedCandidates = [...strongestOwnedCandidates].sort((left, right) =>
      left.candidate.canonicalId.localeCompare(right.candidate.canonicalId),
    );
    const winner = sortedOwnedCandidates[0]!;
    if (sortedOwnedCandidates.length > 1) {
      const sortedCandidates = sortedOwnedCandidates.map((owned) => owned.candidate);
      const collapsedIdentity = CommandTargetResolver.collapsedOverloadIdentity(
        sortedCandidates,
        pattern,
      );
      if (collapsedIdentity === undefined) {
        throw new AmbiguousSymbolTargetError(args.rawTarget, sortedCandidates);
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
    fileSuffix: string | undefined,
  ): Promise<void> {
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

  private static async collectCandidates(
    acceptedFilesByBackend: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
    pattern: SymbolTargetPattern,
  ): Promise<readonly OwnedCandidate[]> {
    const ownedCandidates: OwnedCandidate[] = [];
    for (const [backend, accepted] of acceptedFilesByBackend) {
      const searchFiles = CommandTargetResolver.filesMatchingSuffix(accepted, pattern.fileSuffix);
      const candidates = await backend.findTargetCandidates(searchFiles, pattern);
      ownedCandidates.push(...candidates.map((candidate) => ({ candidate, backend })));
    }
    return ownedCandidates;
  }

  private static filesMatchingSuffix(
    files: readonly ResolvedPath[],
    fileSuffix: string | undefined,
  ): readonly ResolvedPath[] {
    if (fileSuffix === undefined) {
      return files;
    }
    return files.filter((file) => SymbolTargetGrammar.fileSuffixMatches(file.relative, fileSuffix));
  }

  private static nonDominatedCandidates(
    candidates: readonly OwnedCandidate[],
    pattern: SymbolTargetPattern,
  ): readonly OwnedCandidate[] {
    const candidateMatches: OwnedCandidateMatch[] = [];
    for (const ownedCandidate of candidates) {
      const match = SymbolTargetGrammar.match(pattern, ownedCandidate.candidate.symbol.identity);
      if (match !== undefined) {
        candidateMatches.push({ ownedCandidate, specificity: match.specificity });
      }
    }
    return candidateMatches
      .filter(
        (candidateMatch) =>
          !candidateMatches.some((otherMatch) =>
            SymbolTargetGrammar.dominates(otherMatch.specificity, candidateMatch.specificity),
          ),
      )
      .map((candidateMatch) => candidateMatch.ownedCandidate);
  }

  private static collapsedOverloadIdentity(
    candidates: readonly SymbolTargetCandidate[],
    pattern: SymbolTargetPattern,
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
