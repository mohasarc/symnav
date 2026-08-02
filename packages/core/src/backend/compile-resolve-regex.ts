import { InvalidResolveRegexError } from "./errors.js";

export function compileResolveRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const v8Prefix = `Invalid regular expression: /${pattern}/: `;
    const detail = message.startsWith(v8Prefix) ? message.slice(v8Prefix.length) : message;
    throw new InvalidResolveRegexError(pattern, detail);
  }
}
