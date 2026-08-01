import { UserFacingError } from "../errors.js";
import type { SymbolIdentity, SymbolPathSegment } from "./symbol-identity.js";

const SEGMENT_SEPARATOR = "::";
const DISAMBIGUATOR_PREFIX = "#";

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

export function formatSymbolIdentity(identity: SymbolIdentity): string {
  if (identity.file.includes(SEGMENT_SEPARATOR)) {
    throw new InvalidSymbolIdError('file portion must not contain "::"', identity.file);
  }
  return [identity.file, formatSymbolPath(identity.segments)].join(SEGMENT_SEPARATOR);
}

export function formatSymbolPath(segments: readonly SymbolPathSegment[]): string {
  return segments.map(formatSegment).join(SEGMENT_SEPARATOR);
}

function formatSegment(segment: SymbolPathSegment): string {
  if (segment.disambiguator === undefined) {
    return segment.name;
  }
  return `${segment.name}${DISAMBIGUATOR_PREFIX}${segment.disambiguator}`;
}
