import type { SymbolPathSegment } from "./symbol-identity.js";

export const SYMBOL_DISAMBIGUATOR_PREFIX = "#";

type SymbolPathSegmentParseResult =
  | {
      readonly outcome: "parsed";
      readonly segment: SymbolPathSegment;
    }
  | {
      readonly outcome: "invalid";
      readonly explanation: string;
    };

export class SymbolPathSegmentParser {
  static parse(segment: string): SymbolPathSegmentParseResult {
    if (segment.length === 0) {
      return {
        outcome: "invalid",
        explanation: 'empty path segment between "::" separators',
      };
    }
    const hashIndex = segment.lastIndexOf(SYMBOL_DISAMBIGUATOR_PREFIX);
    if (hashIndex === -1) {
      return { outcome: "parsed", segment: { name: segment } };
    }
    const name = segment.slice(0, hashIndex);
    const disambiguatorText = segment.slice(hashIndex + SYMBOL_DISAMBIGUATOR_PREFIX.length);
    if (name.length === 0) {
      return { outcome: "parsed", segment: { name: segment } };
    }
    if (!/^[1-9][0-9]*$/.test(disambiguatorText)) {
      return {
        outcome: "invalid",
        explanation: `disambiguator must be a positive integer (got ${JSON.stringify(disambiguatorText)})`,
      };
    }
    return {
      outcome: "parsed",
      segment: { name, disambiguator: Number.parseInt(disambiguatorText, 10) },
    };
  }
}
