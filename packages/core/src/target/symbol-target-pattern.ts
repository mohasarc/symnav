import { SEGMENT_SEPARATOR } from "../intermediate-representation/canonical-identity.js";
import type {
  SymbolIdentity,
  SymbolPathSegment,
} from "../intermediate-representation/symbol-identity.js";
import {
  SymbolPathSegmentParseError,
  SymbolPathSegmentParser,
} from "../intermediate-representation/symbol-path-segment-parser.js";
import { InvalidSymbolTargetError } from "./symbol-target-result.js";

export interface SymbolTargetPattern {
  readonly raw: string;
  readonly fileSuffix: string | undefined;
  readonly segmentSuffix: readonly SymbolPathSegment[];
}

export class SymbolTargetGrammar {
  static parse(raw: string): SymbolTargetPattern {
    if (raw.length === 0) {
      throw new InvalidSymbolTargetError("empty input", raw);
    }
    const parts = raw.split(SEGMENT_SEPARATOR);
    const fileSuffix = SymbolTargetGrammar.fileSuffixFrom(parts);
    const segmentParts = fileSuffix === undefined ? parts : parts.slice(1);
    if (segmentParts.length === 0) {
      throw new InvalidSymbolTargetError("empty symbol target", raw);
    }
    const segmentSuffix = SymbolTargetGrammar.parseSegments(segmentParts, raw);
    return {
      raw,
      fileSuffix,
      segmentSuffix,
    };
  }

  static matches(pattern: SymbolTargetPattern, identity: SymbolIdentity): boolean {
    if (
      pattern.fileSuffix !== undefined &&
      !SymbolTargetGrammar.fileSuffixMatches(identity.file, pattern.fileSuffix)
    ) {
      return false;
    }
    if (pattern.segmentSuffix.length > identity.segments.length) {
      return false;
    }
    const identitySuffix = identity.segments.slice(
      identity.segments.length - pattern.segmentSuffix.length,
    );
    return identitySuffix.every((segment, index) =>
      SymbolTargetGrammar.segmentMatches(pattern.segmentSuffix[index]!, segment),
    );
  }

  static fileSuffixMatches(file: string, suffix: string): boolean {
    if (file === suffix) {
      return true;
    }
    return file.endsWith(`/${suffix}`);
  }

  private static fileSuffixFrom(parts: readonly string[]): string | undefined {
    if (parts.length < 2) {
      return undefined;
    }
    const first = parts[0]!;
    if (first.includes("/") || first.includes("\\") || first.includes(".")) {
      return first;
    }
    return undefined;
  }

  private static parseSegments(
    segmentParts: readonly string[],
    raw: string,
  ): readonly SymbolPathSegment[] {
    try {
      return segmentParts.map((segment) => SymbolPathSegmentParser.parse(segment));
    } catch (error) {
      if (error instanceof SymbolPathSegmentParseError) {
        throw new InvalidSymbolTargetError(error.explanation, raw);
      }
      throw error;
    }
  }

  private static segmentMatches(pattern: SymbolPathSegment, candidate: SymbolPathSegment): boolean {
    if (pattern.name !== candidate.name) {
      return false;
    }
    return pattern.disambiguator === undefined || pattern.disambiguator === candidate.disambiguator;
  }
}
