import type {
  OverviewExpansionCandidate,
  OverviewExpansionRequest,
} from "./overview-expansion-result.js";

export function renderCandidateError(
  reason: string,
  candidates: readonly OverviewExpansionCandidate[],
): string {
  return `Cannot answer: ${reason}.\n\nCandidates\n${renderCandidates(candidates)}`;
}

function renderCandidates(candidates: readonly OverviewExpansionCandidate[]): string {
  return candidates
    .map((candidate, index) => {
      const glyph = index === candidates.length - 1 ? "└──" : "├──";
      return `${glyph} ${candidate.header}\n`;
    })
    .join("");
}

export function formatRequest(request: OverviewExpansionRequest): string {
  if (request.at !== undefined && request.line !== undefined) {
    return `--at ${JSON.stringify(request.at)} on line ${request.line}`;
  }
  if (request.at !== undefined) return `--at ${JSON.stringify(request.at)}`;
  return `line ${request.line}`;
}
