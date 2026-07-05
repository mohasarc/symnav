export abstract class UserFacingError extends Error {
  abstract get reason(): string;

  render(): string {
    return `Cannot answer: ${this.reason}.\n`;
  }
}
