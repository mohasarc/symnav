import { UserFacingError } from "@symnav/core";

export class ConflictingResolveFlagsError extends UserFacingError {
  get reason(): string {
    return "--regex cannot be combined with --fuzzy";
  }
}
