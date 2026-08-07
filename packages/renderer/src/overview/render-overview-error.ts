import type { OverviewExpansionCandidate, OverviewExpansionRequest } from "@symnav/core";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewError,
  OverviewTargetNotFoundError,
} from "@symnav/core";

import { treeGlyphsFor } from "../shared/render-format.js";

export class OverviewErrorRenderer {
  static render(err: unknown): string | undefined {
    if (err instanceof AmbiguousOverviewError) {
      return OverviewErrorRenderer.renderCandidateError(
        OverviewErrorRenderer.ambiguityStatementFor(err),
        err.candidates,
      );
    }
    if (err instanceof OverviewTargetNotFoundError) {
      return `Cannot answer: no overview target matching ${OverviewErrorRenderer.formatRequest(err.request)}.\n`;
    }
    return undefined;
  }

  private static ambiguityStatementFor(err: AmbiguousOverviewError): string {
    if (err instanceof AmbiguousLineTargetError) {
      return `line ${err.line} matches multiple overview nodes; use --at with copied header text`;
    }
    return "overview target matches multiple nodes";
  }

  private static renderCandidateError(
    reason: string,
    candidates: readonly OverviewExpansionCandidate[],
  ): string {
    return `Cannot answer: ${reason}.\n\nCandidates\n${OverviewErrorRenderer.renderCandidates(candidates)}`;
  }

  private static renderCandidates(candidates: readonly OverviewExpansionCandidate[]): string {
    return candidates
      .map((candidate, index) => {
        const { branchGlyph } = treeGlyphsFor(index === candidates.length - 1);
        return `${branchGlyph}${candidate.header}\n`;
      })
      .join("");
  }

  private static formatRequest(request: OverviewExpansionRequest): string {
    if (request.at !== undefined && request.line !== undefined) {
      return `--at ${JSON.stringify(request.at)} on line ${request.line}`;
    }
    if (request.at !== undefined) return `--at ${JSON.stringify(request.at)}`;
    return `line ${request.line}`;
  }
}
