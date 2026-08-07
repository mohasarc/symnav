import type {
  BackendRouter,
  NavigationDiagnostic,
  ResultWithDiagnostics,
  Workspace,
} from "@symnav/core";

export class NavigationDiagnosticsCollector {
  static async attach<Result extends ResultWithDiagnostics>(
    result: Result,
    workspace: Workspace,
    router: BackendRouter,
  ): Promise<Result> {
    const diagnostics = await NavigationDiagnosticsCollector.collect(workspace, router);
    if (diagnostics.length === 0) return result;
    return { ...result, diagnostics };
  }

  private static async collect(
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
}
