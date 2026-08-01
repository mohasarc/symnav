import type {
  BackendRouter,
  LanguageBackend,
  ResolvedPath,
  SymbolOverviewNode,
  Workspace,
} from "@symnav/core";
import { fileSuffixMatches, parseSymbolTargetPattern } from "@symnav/core";

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly containingLine: number | undefined;
}

export async function resolveSymbolTargetForCommand(
  args: ResolveSymbolTargetForCommandArgs,
): Promise<SymbolOverviewNode> {
  const pattern = parseSymbolTargetPattern(args.rawTarget);
  const files = await args.workspace.enumerate();
  await validateExactMissingPath(args, files, pattern.fileSuffix);
  const backend = backendForPattern(args.router, files, pattern.fileSuffix);
  const accepted = files.filter((file) => backend.accepts(file.relative));
  return backend.resolveSymbolTarget(accepted, pattern, { containingLine: args.containingLine });
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

function backendForPattern(
  router: BackendRouter,
  files: readonly ResolvedPath[],
  fileSuffix: string | undefined,
): LanguageBackend {
  const matchingFile =
    fileSuffix === undefined
      ? undefined
      : files.find((file) => fileSuffixMatches(file.relative, fileSuffix));
  if (matchingFile !== undefined) {
    return router.findOrThrow(matchingFile.relative);
  }
  for (const file of files) {
    const backend = router.find(file.relative);
    if (backend !== undefined) {
      return backend;
    }
  }
  return router.findOrThrow(fileSuffix ?? "");
}
