import { InvalidResolveRegexError } from "@symnav/core";

export class ResolveErrorRenderer {
  static render(err: unknown): string | undefined {
    if (err instanceof InvalidResolveRegexError) {
      return `Cannot answer: invalid resolve regex ${JSON.stringify(err.pattern)}: ${err.detail}.\n`;
    }
    return undefined;
  }
}
