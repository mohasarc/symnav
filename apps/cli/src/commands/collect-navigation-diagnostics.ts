import type { BackendRouter, NavigationDiagnostic, Workspace } from "@symnav/core";

export async function collectNavigationDiagnostics(
  workspace: Workspace,
  router: BackendRouter,
): Promise<readonly NavigationDiagnostic[]> {
  const byKey = new Map<string, NavigationDiagnostic>();
  const files = await workspace.enumerate();

  for (const file of files) {
    const backend = router.find(file.relative);
    if (!backend) continue;
    const symbols = await backend.fileSymbols(file);
    for (const diagnostic of symbols.diagnostics ?? []) {
      byKey.set(diagnostic.key, diagnostic);
    }
  }

  return [...byKey.values()];
}
