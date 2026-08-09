import { InvalidRegexError, type RegexSubject } from "./errors.js";

export function compileRegex(pattern: string, subject: RegexSubject): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const v8Prefix = `Invalid regular expression: /${pattern}/: `;
    const detail = message.startsWith(v8Prefix) ? message.slice(v8Prefix.length) : message;
    throw new InvalidRegexError(subject, pattern, detail);
  }
}
