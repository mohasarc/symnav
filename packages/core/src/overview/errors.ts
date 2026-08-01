import { UserFacingError } from "../errors.js";
import type {
  OverviewExpansionCandidate,
  OverviewExpansionRequest,
} from "./overview-expansion-result.js";
import { formatRequest, renderCandidateError } from "./overview-query.js";

export abstract class AmbiguousOverviewError extends UserFacingError {
  constructor(readonly candidates: readonly OverviewExpansionCandidate[]) {
    super();
  }
}

export class AmbiguousOverviewTargetError extends AmbiguousOverviewError {
  constructor(candidates: readonly OverviewExpansionCandidate[]) {
    super(candidates);
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
  constructor(readonly request: OverviewExpansionRequest) {
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

export class AmbiguousLineTargetError extends AmbiguousOverviewError {
  constructor(
    readonly line: number,
    candidates: readonly OverviewExpansionCandidate[],
  ) {
    super(candidates);
    this.name = "AmbiguousLineTargetError";
  }

  get reason(): string {
    return `line ${this.line} matches multiple overview nodes; use --at with copied header text`;
  }

  override render(): string {
    return renderCandidateError(this.reason, this.candidates);
  }
}
