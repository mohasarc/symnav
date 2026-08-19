import type { SymbolPathSegment } from "./symbol-identity.js";

export type SegmentParse =
  | { readonly outcome: "parsed"; readonly segment: SymbolPathSegment }
  | { readonly outcome: "rejected"; readonly explanation: string };

const DISAMBIGUATOR_PREFIX = "#";

export class SegmentGrammar {
  static parse(segment: string): SegmentParse {
    if (segment.length === 0) {
      return {
        outcome: "rejected",
        explanation: 'empty path segment between "::" separators',
      };
    }
    const hashIndex = segment.lastIndexOf(DISAMBIGUATOR_PREFIX);
    if (hashIndex === -1) {
      return { outcome: "parsed", segment: { name: segment } };
    }
    const name = segment.slice(0, hashIndex);
    const disambiguatorText = segment.slice(hashIndex + DISAMBIGUATOR_PREFIX.length);
    if (name.length === 0) {
      return { outcome: "parsed", segment: { name: segment } };
    }
    if (!/^[1-9][0-9]*$/.test(disambiguatorText)) {
      return {
        outcome: "rejected",
        explanation: `disambiguator must be a positive integer (got ${JSON.stringify(disambiguatorText)})`,
      };
    }
    return {
      outcome: "parsed",
      segment: { name, disambiguator: Number.parseInt(disambiguatorText, 10) },
    };
  }

  static format(segment: SymbolPathSegment): string {
    if (segment.disambiguator === undefined) {
      return segment.name;
    }
    return `${segment.name}${DISAMBIGUATOR_PREFIX}${segment.disambiguator}`;
  }
}
