import { UserFacingError } from "../errors.js";

export class InvalidPageRequestError extends UserFacingError {
  constructor(private readonly detail: string) {
    super();
    this.name = "InvalidPageRequestError";
  }

  get reason(): string {
    return `invalid page request: ${this.detail}`;
  }
}

export class PageOutOfRangeError extends UserFacingError {
  constructor(
    private readonly requestedPage: number,
    private readonly pageCount: number,
  ) {
    super();
    this.name = "PageOutOfRangeError";
  }

  get reason(): string {
    return `page ${this.requestedPage} is out of range (1-${this.pageCount})`;
  }
}
