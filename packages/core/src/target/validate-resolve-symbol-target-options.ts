import type { ResolveSymbolTargetOptions } from "../backend/language-backend.js";
import { UserFacingError } from "../errors.js";
import { isPositiveInteger } from "../validation/is-positive-integer.js";

export class InvalidSymbolTargetRequestError extends UserFacingError {
  constructor(private readonly explanation: string) {
    super();
    this.name = "InvalidSymbolTargetRequestError";
  }

  get reason(): string {
    return this.explanation;
  }
}

export function validateResolveSymbolTargetOptions(options: ResolveSymbolTargetOptions): void {
  const { containingLine } = options;
  if (containingLine !== undefined && !isPositiveInteger(containingLine)) {
    throw new InvalidSymbolTargetRequestError(
      `containingLine must be a positive integer, got ${containingLine}`,
    );
  }
}
