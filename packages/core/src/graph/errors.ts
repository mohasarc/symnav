import { UserFacingError } from "../errors.js";
import { MAX_GRAPH_DEPTH } from "./graph-path.js";

export class GraphDepthExceededError extends UserFacingError {
  constructor(private readonly requestedDepth: number) {
    super();
    this.name = "GraphDepthExceededError";
  }

  get reason(): string {
    return `--depth ${this.requestedDepth} exceeds the maximum of ${MAX_GRAPH_DEPTH}; run with --depth ${MAX_GRAPH_DEPTH}, then run graph again from a leaf symbol`;
  }
}

export class InvalidGraphRequestError extends UserFacingError {
  constructor(private readonly explanation: string) {
    super();
    this.name = "InvalidGraphRequestError";
  }

  get reason(): string {
    return this.explanation;
  }
}
