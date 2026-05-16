export abstract class UserFacingError extends Error {
  abstract get reason(): string;
}
