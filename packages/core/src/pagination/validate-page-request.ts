import { isPositiveInteger } from "../validation/is-positive-integer.js";
import { InvalidPageRequestError } from "./errors.js";
import type { PageRequest } from "./paginator.js";

export function validatePageRequest(request: PageRequest): void {
  const { all, page, pageSize } = request;
  if (all && page !== undefined) {
    throw new InvalidPageRequestError("--all cannot be combined with an explicit page");
  }
  if (page !== undefined && !isPositiveInteger(page)) {
    throw new InvalidPageRequestError(`page must be a positive integer, got ${page}`);
  }
  if (pageSize !== undefined && !isPositiveInteger(pageSize)) {
    throw new InvalidPageRequestError(`page size must be a positive integer, got ${pageSize}`);
  }
}
