import type { SymbolTargetCandidate } from "@symnav/core";
import { AmbiguousSymbolTargetError } from "@symnav/core";

import { treeGlyphsFor } from "../shared/render-format.js";

export class SymbolTargetErrorRenderer {
  static render(err: unknown): string | undefined {
    if (err instanceof AmbiguousSymbolTargetError) {
      return SymbolTargetErrorRenderer.renderAmbiguity(err);
    }
    return undefined;
  }

  private static renderAmbiguity(err: AmbiguousSymbolTargetError): string {
    return [
      `Cannot answer: symbol target ${JSON.stringify(err.rawTarget)} is ambiguous.`,
      "",
      "Candidates",
      ...err.candidates.flatMap((candidate, index) =>
        SymbolTargetErrorRenderer.candidateLines(candidate, index === err.candidates.length - 1),
      ),
      "",
      "Copy a candidate id, or narrow with --line.",
      "",
    ].join("\n");
  }

  private static candidateLines(candidate: SymbolTargetCandidate, isLast: boolean): string[] {
    const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
    return [
      `${branchGlyph}${candidate.canonicalId}`,
      ...candidate.header.lines.map((line) => `${continuationGlyph}${line}`),
    ];
  }
}
