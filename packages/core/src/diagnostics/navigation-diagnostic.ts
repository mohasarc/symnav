export type NavigationDiagnosticSeverity = "warning";

export interface NavigationDiagnostic {
  readonly severity: NavigationDiagnosticSeverity;
  readonly message: string;
  readonly key: string;
}

export interface DiagnosticSink {
  report(diagnostic: NavigationDiagnostic): void;
}

export class CollectingDiagnosticSink implements DiagnosticSink {
  readonly #diagnostics: NavigationDiagnostic[] = [];
  readonly #keys = new Set<string>();

  report(diagnostic: NavigationDiagnostic): void {
    if (this.#keys.has(diagnostic.key)) return;
    this.#keys.add(diagnostic.key);
    this.#diagnostics.push(diagnostic);
  }

  diagnostics(): readonly NavigationDiagnostic[] {
    return this.#diagnostics;
  }
}
