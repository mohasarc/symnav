export type DaemonDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | readonly DaemonDiagnosticValue[]
  | { readonly [key: string]: DaemonDiagnosticValue };

export type DaemonDiagnostics = Readonly<Record<string, DaemonDiagnosticValue>>;
