import { compileRegex } from "./compile-regex.js";
import { InvalidRegexError, InvalidResolveRegexError } from "./errors.js";

export function compileResolveRegex(pattern: string): RegExp {
  try {
    return compileRegex(pattern, "resolve");
  } catch (err) {
    if (err instanceof InvalidRegexError) {
      throw new InvalidResolveRegexError(err.pattern, err.detail);
    }
    throw err;
  }
}
