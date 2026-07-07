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

  report(diagnostic: NavigationDiagnostic): void {
    this.#diagnostics.push(diagnostic);
  }

  diagnostics(): readonly NavigationDiagnostic[] {
    return this.#diagnostics;
  }
}
