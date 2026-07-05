import { UserFacingError } from "../errors.js";
import { MAX_GRAPH_DEPTH } from "./graph-path.js";

export class GraphDepthExceededError extends UserFacingError {
  constructor(private readonly requestedDepth: number) {
    super();
    this.name = "GraphDepthExceededError";
  }

  get reason(): string {
    return `graph depth ${this.requestedDepth} exceeds maximum supported depth ${MAX_GRAPH_DEPTH}`;
  }

  override render(): string {
    return (
      `Cannot run graph with depth ${this.requestedDepth}.\n` +
      `Maximum supported depth is ${MAX_GRAPH_DEPTH}.\n` +
      "\n" +
      "To continue exploration:\n" +
      `1. Run with depth ${MAX_GRAPH_DEPTH}.\n` +
      "2. Pick a leaf symbol from the output.\n" +
      "3. Run graph again from that symbol.\n"
    );
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
