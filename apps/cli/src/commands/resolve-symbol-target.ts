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
  InvalidSymbolTargetRequestError,
  NoSupportedFilesError,
  SymbolTargetNotFoundError,
  fileSuffixMatches,
  formatSymbolIdentity,
  isPositiveInteger,
  parseSymbolTargetPattern,
} from "@symnav/core";

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

export async function resolveSymbolTargetForCommand(
  args: ResolveSymbolTargetForCommandArgs,
): Promise<ResolvedCommandTarget> {
  const containingLine = containingLineFrom(args.line);
  const pattern = parseSymbolTargetPattern(args.rawTarget);
  const files = await args.workspace.enumerate();
  await throwIfPathlikeSuffixUnresolvable(args, files, pattern.fileSuffix);
  const acceptedFilesByBackend = groupFilesByAcceptingBackend(args.router, files);
  if (acceptedFilesByBackend.size === 0) {
    throw new NoSupportedFilesError();
  }
  const ownedCandidates = await collectCandidates(acceptedFilesByBackend, pattern, containingLine);
  const sortedOwnedCandidates = [...ownedCandidates].sort((left, right) =>
    left.candidate.canonicalId.localeCompare(right.candidate.canonicalId),
  );
  if (sortedOwnedCandidates.length === 0) {
    throw new SymbolTargetNotFoundError(pattern);
  }
  const winner = sortedOwnedCandidates[0]!;
  if (sortedOwnedCandidates.length > 1) {
    const sortedCandidates = sortedOwnedCandidates.map((owned) => owned.candidate);
    const collapsedIdentity = collapsedOverloadIdentity(sortedCandidates, pattern);
    if (collapsedIdentity === undefined) {
      throw new AmbiguousSymbolTargetError(pattern, sortedCandidates);
    }
    return resolvedTarget(collapsedIdentity, winner.backend, acceptedFilesByBackend);
  }
  return resolvedTarget(winner.candidate.symbol.identity, winner.backend, acceptedFilesByBackend);
}

function containingLineFrom(line: ResolveSymbolTargetForCommandArgs["line"]): number | undefined {
  if (line === undefined) {
    return undefined;
  }
  const numericLine = typeof line === "number" ? line : Number(line);
  if (!isPositiveInteger(numericLine)) {
    throw new InvalidSymbolTargetRequestError(`line must be a positive integer, got ${line}`);
  }
  return numericLine;
}

function resolvedTarget(
  identity: SymbolIdentity,
  backend: LanguageBackend,
  acceptedFilesByBackend: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
): ResolvedCommandTarget {
  return { identity, backend, files: acceptedFilesByBackend.get(backend) ?? [] };
}

async function throwIfPathlikeSuffixUnresolvable(
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
): Promise<readonly OwnedCandidate[]> {
  const ownedCandidates: OwnedCandidate[] = [];
  for (const [backend, accepted] of acceptedFilesByBackend) {
    const searchFiles = filesMatchingSuffix(accepted, pattern.fileSuffix);
    const candidates = await backend.findTargetCandidates(searchFiles, pattern, { containingLine });
    ownedCandidates.push(...candidates.map((candidate) => ({ candidate, backend })));
  }
  return ownedCandidates;
}

function filesMatchingSuffix(
  files: readonly ResolvedPath[],
  fileSuffix: string | undefined,
): readonly ResolvedPath[] {
  if (fileSuffix === undefined) {
    return files;
  }
  return files.filter((file) => fileSuffixMatches(file.relative, fileSuffix));
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
