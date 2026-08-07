import { UserFacingError } from "../errors.js";
import type {
  OverviewExpansionCandidate,
  OverviewExpansionRequest,
} from "./overview-expansion-result.js";

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
}

export class OverviewTargetNotFoundError extends UserFacingError {
  constructor(readonly request: OverviewExpansionRequest) {
    super();
    this.name = "OverviewTargetNotFoundError";
  }

  get reason(): string {
    return `no overview target matching ${this.describeRequest()}`;
  }

  private describeRequest(): string {
    if (this.request.at !== undefined && this.request.line !== undefined) {
      return `header text ${JSON.stringify(this.request.at)} on line ${this.request.line}`;
    }
    if (this.request.at !== undefined) {
      return `header text ${JSON.stringify(this.request.at)}`;
    }
    return `line ${this.request.line}`;
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
    return `line ${this.line} matches multiple overview nodes`;
  }
}
