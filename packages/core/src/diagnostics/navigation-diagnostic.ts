export type NavigationDiagnosticSeverity = "warning";

export interface NavigationDiagnostic {
  readonly severity: NavigationDiagnosticSeverity;
  readonly message: string;
  readonly dedupeKey: string;
}

export interface DiagnosticSink {
  report(diagnostic: NavigationDiagnostic): void;
}

export class CollectingDiagnosticSink implements DiagnosticSink {
  private readonly collected: NavigationDiagnostic[] = [];
  private readonly dedupeKeys = new Set<string>();

  report(diagnostic: NavigationDiagnostic): void {
    if (this.dedupeKeys.has(diagnostic.dedupeKey)) return;
    this.dedupeKeys.add(diagnostic.dedupeKey);
    this.collected.push(diagnostic);
  }

  diagnostics(): readonly NavigationDiagnostic[] {
    return this.collected;
  }
}
