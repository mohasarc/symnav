export class DaemonControlledFailureMessage {
  static readonly acceptedRequestDidNotComplete =
    "Cannot answer: accepted daemon request did not complete.\n";
  static readonly workspaceCapacityExceeded =
    "Cannot answer: daemon workspace capacity exceeded.\n";
  static readonly responseCapacityExceeded = "Cannot answer: daemon response capacity exceeded.\n";
}
