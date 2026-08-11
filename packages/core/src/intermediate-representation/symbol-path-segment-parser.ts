import type { SymbolPathSegment } from "./symbol-identity.js";

export const SYMBOL_DISAMBIGUATOR_PREFIX = "#";

export class SymbolPathSegmentParseError extends Error {
  constructor(readonly explanation: string) {
    super();
    this.name = "SymbolPathSegmentParseError";
  }
}

export class SymbolPathSegmentParser {
  static parse(segment: string): SymbolPathSegment {
    if (segment.length === 0) {
      throw new SymbolPathSegmentParseError('empty path segment between "::" separators');
    }
    const hashIndex = segment.lastIndexOf(SYMBOL_DISAMBIGUATOR_PREFIX);
    if (hashIndex === -1) {
      return { name: segment };
    }
    const name = segment.slice(0, hashIndex);
    const disambiguatorText = segment.slice(hashIndex + SYMBOL_DISAMBIGUATOR_PREFIX.length);
    if (name.length === 0) {
      return { name: segment };
    }
    if (!/^[1-9][0-9]*$/.test(disambiguatorText)) {
      throw new SymbolPathSegmentParseError(
        `disambiguator must be a positive integer (got ${JSON.stringify(disambiguatorText)})`,
      );
    }
    return { name, disambiguator: Number.parseInt(disambiguatorText, 10) };
  }
}
