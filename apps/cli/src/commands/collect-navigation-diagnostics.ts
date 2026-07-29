import type { BackendRouter, NavigationDiagnostic, Workspace } from "@symnav/core";

export async function collectNavigationDiagnostics(
  workspace: Workspace,
  router: BackendRouter,
): Promise<readonly NavigationDiagnostic[]> {
  const byDedupeKey = new Map<string, NavigationDiagnostic>();
  const files = await workspace.enumerate();

  for (const file of files) {
    const backend = router.find(file.relative);
    if (!backend) continue;
    const entries = await backend.fileEntries(file);
    for (const diagnostic of entries.diagnostics ?? []) {
      byDedupeKey.set(diagnostic.dedupeKey, diagnostic);
    }
  }

  return [...byDedupeKey.values()];
}
