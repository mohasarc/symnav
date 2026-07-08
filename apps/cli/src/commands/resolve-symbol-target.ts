import type {
  BackendRouter,
  LanguageBackend,
  ResolvedPath,
  SymbolOverviewNode,
  Workspace,
} from "@symnav/core";
import { parseSymbolTargetPattern } from "@symnav/core";

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | undefined;
}

export async function resolveSymbolTargetForCommand(
  args: ResolveSymbolTargetForCommandArgs,
): Promise<SymbolOverviewNode> {
  const pattern = parseSymbolTargetPattern(args.rawTarget);
  const files = await args.workspace.enumerate();
  await validateExactMissingPath(args, files, pattern.fileSuffix);
  const backend = backendForPattern(args.router, files, pattern.fileSuffix);
  const accepted = files.filter((file) => backend.accepts(file.relative));
  return backend.resolveSymbolTarget(accepted, pattern, { line: args.line });
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

function fileSuffixMatches(file: string, suffix: string): boolean {
  if (file === suffix) {
    return true;
  }
  return file.endsWith(`/${suffix}`);
}
