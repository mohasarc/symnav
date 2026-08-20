import { UserFacingError } from "../errors.js";

export class InvalidRegexError extends UserFacingError {
  constructor(
    readonly pattern: string,
    readonly detail: string,
  ) {
    super();
    this.name = "InvalidRegexError";
  }

  get reason(): string {
    return `invalid regex ${JSON.stringify(this.pattern)}: ${this.detail}`;
  }
}

export function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const enginePrefix = `Invalid regular expression: /${pattern}/: `;
    const detail = message.startsWith(enginePrefix) ? message.slice(enginePrefix.length) : message;
    throw new InvalidRegexError(pattern, detail);
  }
}
