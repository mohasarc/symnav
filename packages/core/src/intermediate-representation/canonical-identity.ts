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

export function parseSymbolIdentity(raw: string): SymbolIdentity {
  if (raw.length === 0) {
    throw new InvalidSymbolIdError("empty input", raw);
  }
  const firstSeparator = raw.indexOf(SEGMENT_SEPARATOR);
  if (firstSeparator === -1) {
    throw new InvalidSymbolIdError("missing `::` separator", raw);
  }
  const file = raw.slice(0, firstSeparator);
  const rest = raw.slice(firstSeparator + SEGMENT_SEPARATOR.length);
  if (file.length === 0) {
    throw new InvalidSymbolIdError("empty file portion", raw);
  }
  const segmentStrings = rest.split(SEGMENT_SEPARATOR);
  const segments = segmentStrings.map((segment) => parseSegment(segment, raw));
  return { file, segments };
}

function parseSegment(segment: string, raw: string): SymbolPathSegment {
  if (segment.length === 0) {
    throw new InvalidSymbolIdError('empty path segment between "::" separators', raw);
  }
  const hashIndex = segment.lastIndexOf(DISAMBIGUATOR_PREFIX);
  if (hashIndex === -1) {
    return { name: segment };
  }
  const name = segment.slice(0, hashIndex);
  const disambiguatorText = segment.slice(hashIndex + DISAMBIGUATOR_PREFIX.length);
  if (name.length === 0) {
    return { name: segment };
  }
  if (!/^[1-9][0-9]*$/.test(disambiguatorText)) {
    throw new InvalidSymbolIdError(
      `disambiguator must be a positive integer (got ${JSON.stringify(disambiguatorText)})`,
      raw,
    );
  }
  return { name, disambiguator: Number.parseInt(disambiguatorText, 10) };
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
