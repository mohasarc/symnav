import type {
  BackendRouter,
  LanguageBackend,
  ResolvedPath,
  SymbolIdentity,
  SymbolTargetCandidate,
  SymbolTargetPattern,
  Workspace,
} from "@symnav/core";
import {
  AmbiguousSymbolTargetError,
  SymbolTargetNotFoundError,
  fileSuffixMatches,
  formatSymbolIdentity,
  parseSymbolTargetPattern,
} from "@symnav/core";

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly containingLine: number | undefined;
}

export async function resolveSymbolTargetForCommand(
  args: ResolveSymbolTargetForCommandArgs,
): Promise<SymbolIdentity> {
  const pattern = parseSymbolTargetPattern(args.rawTarget);
  const files = await args.workspace.enumerate();
  await validateExactMissingPath(args, files, pattern.fileSuffix);
  const acceptedFilesByBackend = groupFilesByAcceptingBackend(args.router, files);
  if (acceptedFilesByBackend.size === 0) {
    args.router.findOrThrow(pattern.fileSuffix ?? "");
  }
  const candidates = await collectCandidates(acceptedFilesByBackend, pattern, args.containingLine);
  const sortedCandidates = [...candidates].sort((left, right) =>
    left.canonicalId.localeCompare(right.canonicalId),
  );
  if (sortedCandidates.length === 0) {
    throw new SymbolTargetNotFoundError(pattern);
  }
  if (sortedCandidates.length > 1) {
    const collapsedIdentity = collapsedOverloadIdentity(sortedCandidates, pattern);
    if (collapsedIdentity !== undefined) {
      return collapsedIdentity;
    }
    throw new AmbiguousSymbolTargetError(pattern, sortedCandidates);
  }
  return sortedCandidates[0]!.symbol.identity;
}

async function validateExactMissingPath(
  args: ResolveSymbolTargetForCommandArgs,
  files: readonly ResolvedPath[],
  fileSuffix: string | undefined,
): Promise<void> {
  if (
    fileSuffix === undefined ||
    files.some((file) => fileSuffixMatches(file.relative, fileSuffix))
  ) {
    return;
  }
  if (fileSuffix.includes("/")) {
    await args.workspace.resolveInputPath(fileSuffix, args.cwd);
  }
}

function groupFilesByAcceptingBackend(
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

async function collectCandidates(
  acceptedFilesByBackend: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
  pattern: SymbolTargetPattern,
  containingLine: number | undefined,
): Promise<readonly SymbolTargetCandidate[]> {
  const candidates: SymbolTargetCandidate[] = [];
  for (const [backend, accepted] of acceptedFilesByBackend) {
    candidates.push(...(await backend.findTargetCandidates(accepted, pattern, { containingLine })));
  }
  return candidates;
}

function collapsedOverloadIdentity(
  candidates: readonly SymbolTargetCandidate[],
  pattern: SymbolTargetPattern,
): SymbolIdentity | undefined {
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
  return identities[0]!;
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
