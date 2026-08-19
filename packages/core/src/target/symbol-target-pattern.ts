import {
  InvalidSymbolIdError,
  SEGMENT_SEPARATOR,
  parseSegment,
} from "../intermediate-representation/canonical-identity.js";
import { UserFacingError } from "../errors.js";
import type {
  SymbolIdentity,
  SymbolPathSegment,
} from "../intermediate-representation/symbol-identity.js";

export interface SymbolTargetPattern {
  readonly raw: string;
  readonly fileSuffix: string | undefined;
  readonly segmentSuffix: readonly SymbolPathSegment[];
}

export class InvalidSymbolTargetError extends UserFacingError {
  constructor(
    readonly explanation: string,
    readonly raw: string,
  ) {
    super();
    this.name = "InvalidSymbolTargetError";
  }

  get reason(): string {
    return `invalid symbol target (${this.explanation}): ${JSON.stringify(this.raw)}`;
  }
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
      throw new InvalidSymbolIdError("empty symbol target", raw);
    }
    try {
      return {
        raw,
        fileSuffix,
        segmentSuffix: segmentParts.map((segment) => parseSegment(segment, raw)),
      };
    } catch (error) {
      if (error instanceof InvalidSymbolIdError) {
        throw new InvalidSymbolTargetError(error.explanation, error.raw);
      }
      throw error;
    }
  }

  static matches(pattern: SymbolTargetPattern, identity: SymbolIdentity): boolean {
    if (pattern.fileSuffix !== undefined) {
      if (!SymbolTargetGrammar.fileSuffixMatches(identity.file, pattern.fileSuffix)) {
        return false;
      }
      if (pattern.segmentSuffix.length !== identity.segments.length) {
        return false;
      }
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

  private static segmentMatches(pattern: SymbolPathSegment, candidate: SymbolPathSegment): boolean {
    if (pattern.name !== candidate.name) {
      return false;
    }
    return pattern.disambiguator === undefined || pattern.disambiguator === candidate.disambiguator;
  }
}
