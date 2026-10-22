export type DaemonDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | readonly DaemonDiagnosticValue[]
  | { readonly [key: string]: DaemonDiagnosticValue };

export type DaemonDiagnostics = Readonly<Record<string, DaemonDiagnosticValue>>;

export class DaemonDiagnosticValues {
  static isDiagnostics(value: unknown): value is DaemonDiagnostics {
    return this.isObject(value, new Set<object>());
  }

  private static isValue(value: unknown, ancestors: Set<object>): value is DaemonDiagnosticValue {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return this.isArray(value, ancestors);
    return this.isObject(value, ancestors);
  }

  private static isArray(value: readonly unknown[], ancestors: Set<object>): boolean {
    if (ancestors.has(value)) return false;
    const descendants = new Set(ancestors).add(value);
    return value.every((entry) => this.isValue(entry, descendants));
  }

  private static isObject(
    value: unknown,
    ancestors: Set<object>,
  ): value is Readonly<Record<string, DaemonDiagnosticValue>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (ancestors.has(value)) return false;
    const descendants = new Set(ancestors).add(value);
    return Object.values(value).every((entry) => this.isValue(entry, descendants));
  }
}
