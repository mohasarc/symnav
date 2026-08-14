import { InvalidRegexError } from "@symnav/core";

export class ResolveErrorRenderer {
  static render(err: unknown): string | undefined {
    if (err instanceof InvalidRegexError) {
      return `Cannot answer: invalid regex ${JSON.stringify(err.pattern)}: ${err.detail}.\n`;
    }
    return undefined;
  }
}
