import { UserFacingError } from "../errors.js";

export class InvalidSymbolTargetRequestError extends UserFacingError {
  constructor(private readonly explanation: string) {
    super();
    this.name = "InvalidSymbolTargetRequestError";
  }

  get reason(): string {
    return this.explanation;
  }
}
