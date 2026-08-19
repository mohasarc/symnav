import { UserFacingError } from "../errors.js";
import { SegmentGrammar } from "./segment-grammar.js";
import type { SymbolIdentity, SymbolPathSegment } from "./symbol-identity.js";

export const SEGMENT_SEPARATOR = "::";

export class InvalidSymbolIdError extends UserFacingError {
  constructor(
    private readonly explanation: string,
    private readonly raw: string,
  ) {
    super();
    this.name = "InvalidSymbolIdError";
  }

  get reason(): string {
    return `invalid symbol id (${this.explanation}): ${JSON.stringify(this.raw)}`;
  }
}

export function parseSegment(segment: string, raw: string): SymbolPathSegment {
  const parsed = SegmentGrammar.parse(segment);
  if (parsed.outcome === "rejected") {
    throw new InvalidSymbolIdError(parsed.explanation, raw);
  }
  return parsed.segment;
}

export function formatSymbolIdentity(identity: SymbolIdentity): string {
  if (identity.file.includes(SEGMENT_SEPARATOR)) {
    throw new InvalidSymbolIdError('file portion must not contain "::"', identity.file);
  }
  return [identity.file, formatSymbolPath(identity.segments)].join(SEGMENT_SEPARATOR);
}

export function formatSymbolPath(segments: readonly SymbolPathSegment[]): string {
  return segments.map(SegmentGrammar.format).join(SEGMENT_SEPARATOR);
}
