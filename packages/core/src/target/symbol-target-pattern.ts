import { SEGMENT_SEPARATOR } from "../intermediate-representation/canonical-identity.js";
import type {
  SymbolIdentity,
  SymbolPathSegment,
} from "../intermediate-representation/symbol-identity.js";
import { SymbolPathSegmentParser } from "../intermediate-representation/symbol-path-segment-parser.js";
import { InvalidSymbolTargetError } from "./symbol-target-result.js";

export interface SymbolTargetPattern {
  readonly raw: string;
  readonly fileSuffix: string | undefined;
  readonly segmentSuffix: readonly SymbolPathSegment[];
}

export type SymbolPathSpecificity = "exact" | "suffix";

export type FilePathSpecificity = "exact" | "suffix" | "unspecified";

export interface SymbolTargetSpecificity {
  readonly symbolPath: SymbolPathSpecificity;
  readonly filePath: FilePathSpecificity;
}

export interface SymbolTargetMatch {
  readonly specificity: SymbolTargetSpecificity;
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

  static match(
    pattern: SymbolTargetPattern,
    identity: SymbolIdentity,
  ): SymbolTargetMatch | undefined {
    if (
      pattern.fileSuffix !== undefined &&
      !SymbolTargetGrammar.fileSuffixMatches(identity.file, pattern.fileSuffix)
    ) {
      return undefined;
    }
    if (pattern.segmentSuffix.length > identity.segments.length) {
      return undefined;
    }
    const identitySuffix = identity.segments.slice(
      identity.segments.length - pattern.segmentSuffix.length,
    );
    const symbolPathMatches = identitySuffix.every((segment, index) =>
      SymbolTargetGrammar.segmentMatches(pattern.segmentSuffix[index]!, segment),
    );
    if (!symbolPathMatches) {
      return undefined;
    }
    return {
      specificity: {
        symbolPath: pattern.segmentSuffix.length === identity.segments.length ? "exact" : "suffix",
        filePath: SymbolTargetGrammar.filePathSpecificity(pattern.fileSuffix, identity.file),
      },
    };
  }

  static dominates(left: SymbolTargetSpecificity, right: SymbolTargetSpecificity): boolean {
    const leftSymbolPath = SymbolTargetGrammar.symbolPathSpecificityRank(left.symbolPath);
    const rightSymbolPath = SymbolTargetGrammar.symbolPathSpecificityRank(right.symbolPath);
    const leftFilePath = SymbolTargetGrammar.filePathSpecificityRank(left.filePath);
    const rightFilePath = SymbolTargetGrammar.filePathSpecificityRank(right.filePath);
    const atLeastAsSpecific = leftSymbolPath >= rightSymbolPath && leftFilePath >= rightFilePath;
    const moreSpecific = leftSymbolPath > rightSymbolPath || leftFilePath > rightFilePath;
    return atLeastAsSpecific && moreSpecific;
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
    return segmentParts.map((segment) => SymbolTargetGrammar.parseSegment(segment, raw));
  }

  private static parseSegment(segment: string, raw: string): SymbolPathSegment {
    const result = SymbolPathSegmentParser.parse(segment);
    if (result.outcome === "invalid") {
      throw new InvalidSymbolTargetError(result.explanation, raw);
    }
    return result.segment;
  }

  private static segmentMatches(pattern: SymbolPathSegment, candidate: SymbolPathSegment): boolean {
    if (pattern.name !== candidate.name) {
      return false;
    }
    return pattern.disambiguator === undefined || pattern.disambiguator === candidate.disambiguator;
  }

  private static filePathSpecificity(
    fileSuffix: string | undefined,
    identityFile: string,
  ): FilePathSpecificity {
    if (fileSuffix === undefined) {
      return "unspecified";
    }
    return fileSuffix === identityFile ? "exact" : "suffix";
  }

  private static symbolPathSpecificityRank(specificity: SymbolPathSpecificity): number {
    return specificity === "exact" ? 1 : 0;
  }

  private static filePathSpecificityRank(specificity: FilePathSpecificity): number {
    if (specificity === "exact") {
      return 2;
    }
    return specificity === "suffix" ? 1 : 0;
  }
}
