import type { NavigationDiagnostic } from "../diagnostics/navigation-diagnostic.js";
import { UserFacingError } from "../errors.js";
import type { OverviewNode } from "../intermediate-representation/overview-tree.js";
import type { LineRange } from "../intermediate-representation/types.js";

export interface OverviewExpansionRequest {
  readonly depth: number;
  readonly at: string | undefined;
  readonly line: number | undefined;
}

export interface OverviewExpansionCandidate {
  readonly header: string;
  readonly range: LineRange;
  readonly node: OverviewNode;
}

export interface OverviewExpansionResult {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
  readonly request: OverviewExpansionRequest;
  readonly diagnostics?: readonly NavigationDiagnostic[];
}

export class AmbiguousOverviewTargetError extends UserFacingError {
  constructor(readonly candidates: readonly OverviewExpansionCandidate[]) {
    super();
    this.name = "AmbiguousOverviewTargetError";
  }

  get reason(): string {
    return "overview target matches multiple nodes";
  }

  override render(): string {
    return renderCandidateError(this.reason, this.candidates);
  }
}

export class OverviewTargetNotFoundError extends UserFacingError {
  constructor(private readonly request: OverviewExpansionRequest) {
    super();
    this.name = "OverviewTargetNotFoundError";
  }

  get reason(): string {
    return `no overview target matching ${formatRequest(this.request)}`;
  }
}

export class InvalidOverviewExpansionRequestError extends UserFacingError {
  constructor(private readonly detail: string) {
    super();
    this.name = "InvalidOverviewExpansionRequestError";
  }

  get reason(): string {
    return `invalid overview request: ${this.detail}`;
  }
}

export class AmbiguousLineTargetError extends UserFacingError {
  constructor(
    private readonly line: number,
    readonly candidates: readonly OverviewExpansionCandidate[] = [],
  ) {
    super();
    this.name = "AmbiguousLineTargetError";
  }

  get reason(): string {
    return `line ${this.line} matches multiple overview nodes; use --at with copied header text`;
  }

  override render(): string {
    if (this.candidates.length === 0) return super.render();
    return renderCandidateError(this.reason, this.candidates);
  }
}

function renderCandidateError(
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

function formatRequest(request: OverviewExpansionRequest): string {
  if (request.at !== undefined && request.line !== undefined) {
    return `--at ${JSON.stringify(request.at)} on line ${request.line}`;
  }
  if (request.at !== undefined) return `--at ${JSON.stringify(request.at)}`;
  if (request.line !== undefined) return `line ${request.line}`;
  return "overview";
}
