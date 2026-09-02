import type { BackendRouter } from "../backend/backend-router.js";
import { NoSupportedFilesError } from "../backend/errors.js";
import type { LanguageBackend } from "../backend/language-backend.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import { isPositiveInteger } from "../validation/is-positive-integer.js";
import type { ResolvedPath, Workspace } from "../workspace/workspace.js";
import { InvalidSymbolTargetRequestError } from "./invalid-symbol-target-request-error.js";
import { SymbolTargetGrammar } from "./symbol-target-pattern.js";
import type { SymbolTargetRequest } from "./symbol-target-request.js";
import { SymbolTargetRequestMatcher, SymbolTargetRequestParser } from "./symbol-target-request.js";
import type { SymbolTargetCandidate } from "./symbol-target-result.js";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetLineMismatchError,
  SymbolTargetNotFoundError,
} from "./symbol-target-result.js";

export interface ResolveSymbolTargetArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
}

export interface ResolvedSymbolTarget {
  readonly identity: SymbolIdentity;
  readonly backend: LanguageBackend;
  readonly files: readonly ResolvedPath[];
}

interface OwnedCandidate {
  readonly candidate: SymbolTargetCandidate;
  readonly backend: LanguageBackend;
}

interface ValidatedSymbolTargetRequest {
  readonly containingLine: number | undefined;
  readonly request: SymbolTargetRequest;
}

export class SymbolTargetResolver {
  static validateRequest(
    args: Pick<ResolveSymbolTargetArgs, "rawTarget" | "line" | "regex">,
  ): void {
    SymbolTargetResolver.validatedRequestFrom(args);
  }

  static async resolve(args: ResolveSymbolTargetArgs): Promise<ResolvedSymbolTarget> {
    const { containingLine, request } = SymbolTargetResolver.validatedRequestFrom(args);
    const files = await args.workspace.enumerate();
    await SymbolTargetResolver.throwIfFileSuffixUnresolvable(args, files, request);
    const acceptedFilesByBackend = SymbolTargetResolver.groupFilesByAcceptingBackend(
      args.router,
      files,
    );
    if (acceptedFilesByBackend.size === 0) {
      throw new NoSupportedFilesError();
    }
    const matchedCandidates = await SymbolTargetResolver.collectMatchedCandidates(
      acceptedFilesByBackend,
      request,
    );
    if (matchedCandidates.length === 0) {
      throw new SymbolTargetNotFoundError(request.raw);
    }
    const lineCandidates = matchedCandidates.filter((owned) =>
      SymbolTargetResolver.matchesLine(containingLine, owned.candidate.symbol),
    );
    if (containingLine !== undefined && lineCandidates.length === 0) {
      throw new SymbolTargetLineMismatchError(request.raw, containingLine);
    }
    const sortedOwnedCandidates = [...lineCandidates].sort((left, right) =>
      left.candidate.canonicalId.localeCompare(right.candidate.canonicalId),
    );
    const winner = sortedOwnedCandidates[0]!;
    if (sortedOwnedCandidates.length > 1) {
      const sortedCandidates = sortedOwnedCandidates.map((owned) => owned.candidate);
      const collapsedIdentity =
        request.mode === "regular"
          ? SymbolTargetResolver.collapsedOverloadIdentity(sortedCandidates, request.pattern)
          : undefined;
      if (collapsedIdentity === undefined) {
        throw new AmbiguousSymbolTargetError(request.raw, sortedCandidates);
      }
      return SymbolTargetResolver.resolvedTarget(
        collapsedIdentity,
        winner.backend,
        acceptedFilesByBackend,
      );
    }
    return SymbolTargetResolver.resolvedTarget(
      winner.candidate.symbol.identity,
      winner.backend,
      acceptedFilesByBackend,
    );
  }

  private static validatedRequestFrom(
    args: Pick<ResolveSymbolTargetArgs, "rawTarget" | "line" | "regex">,
  ): ValidatedSymbolTargetRequest {
    return {
      containingLine: SymbolTargetResolver.containingLineFrom(args.line),
      request: SymbolTargetRequestParser.parse(args.rawTarget, args.regex),
    };
  }

  private static containingLineFrom(line: ResolveSymbolTargetArgs["line"]): number | undefined {
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
  ): ResolvedSymbolTarget {
    return { identity, backend, files: acceptedFilesByBackend.get(backend) ?? [] };
  }

  private static async throwIfFileSuffixUnresolvable(
    args: ResolveSymbolTargetArgs,
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

  private static collapsedOverloadIdentity(
    candidates: readonly SymbolTargetCandidate[],
    pattern: Extract<SymbolTargetRequest, { readonly mode: "regular" }>["pattern"],
  ): SymbolIdentity | undefined {
    const leafPattern = pattern.segmentSuffix[pattern.segmentSuffix.length - 1];
    if (leafPattern?.disambiguator !== undefined) {
      return undefined;
    }
    const identities = candidates.map((candidate) =>
      SymbolTargetResolver.identityWithoutLeafDisambiguator(candidate.symbol.identity),
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
