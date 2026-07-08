import { InvalidSymbolIdError } from "../intermediate-representation/canonical-identity.js";
import type {
  SymbolIdentity,
  SymbolPathSegment,
} from "../intermediate-representation/symbol-identity.js";

const SEGMENT_SEPARATOR = "::";
const DISAMBIGUATOR_PREFIX = "#";

export interface SymbolTargetPattern {
  readonly raw: string;
  readonly fileSuffix: string | undefined;
  readonly segmentSuffix: readonly SymbolPathSegment[];
}

export function parseSymbolTargetPattern(raw: string): SymbolTargetPattern {
  if (raw.length === 0) {
    throw new InvalidSymbolIdError("empty input", raw);
  }
  const parts = raw.split(SEGMENT_SEPARATOR);
  const fileSuffix = fileSuffixFrom(parts);
  const segmentParts = fileSuffix === undefined ? parts : parts.slice(1);
  if (segmentParts.length === 0) {
    throw new InvalidSymbolIdError("empty symbol target", raw);
  }
  return {
    raw,
    fileSuffix,
    segmentSuffix: segmentParts.map((segment) => parseTargetSegment(segment, raw)),
  };
}

export function symbolTargetMatches(
  pattern: SymbolTargetPattern,
  identity: SymbolIdentity,
): boolean {
  if (pattern.fileSuffix !== undefined && !fileSuffixMatches(identity.file, pattern.fileSuffix)) {
    return false;
  }
  if (pattern.segmentSuffix.length > identity.segments.length) {
    return false;
  }
  const identitySuffix = identity.segments.slice(
    identity.segments.length - pattern.segmentSuffix.length,
  );
  return identitySuffix.every((segment, index) =>
    segmentMatches(pattern.segmentSuffix[index]!, segment),
  );
}

function fileSuffixMatches(file: string, suffix: string): boolean {
  if (file === suffix) {
    return true;
  }
  return file.endsWith(`/${suffix}`);
}

function fileSuffixFrom(parts: readonly string[]): string | undefined {
  if (parts.length < 2) {
    return undefined;
  }
  const first = parts[0]!;
  if (first.includes("/") || first.includes("\\") || first.includes(".")) {
    return first;
  }
  return undefined;
}

function parseTargetSegment(segment: string, raw: string): SymbolPathSegment {
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

function segmentMatches(pattern: SymbolPathSegment, candidate: SymbolPathSegment): boolean {
  if (pattern.name !== candidate.name) {
    return false;
  }
  return pattern.disambiguator === undefined || pattern.disambiguator === candidate.disambiguator;
}
